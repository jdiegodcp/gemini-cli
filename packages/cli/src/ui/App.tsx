/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Box,
  DOMElement,
  measureElement,
  Static,
  Text,
  useStdin,
  useStdout,
  useInput,
  type Key as InkKeyType,
} from 'ink';
import { StreamingState, type HistoryItem, MessageType } from './types.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './hooks/useAuthCommand.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { Header } from './components/Header.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { InputPrompt } from './components/InputPrompt.js';
import { Footer } from './components/Footer.js';
import { Colors } from './colors.js';
import { Help } from './components/Help.js';
import { LoadedSettings } from '../config/settings.js';
import { Tips } from './components/Tips.js';
import { ConsolePatcher } from './utils/ConsolePatcher.js';
import { registerCleanup } from '../utils/cleanup.js';
import { DetailedMessagesDisplay } from './components/DetailedMessagesDisplay.js';
import { HistoryItemDisplay } from './components/HistoryItemDisplay.js';
import { ContextSummaryDisplay } from './components/ContextSummaryDisplay.js';
import { useHistory } from './hooks/useHistoryManager.js';
import process from 'node:process';
import {
  type Config,
  getAllGeminiMdFilenames,
  type ActiveFile,
  ideContext,
} from '@google/gemini-cli-core';
import { useLogger } from './hooks/useLogger.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import {
  SessionStatsProvider,
  useSessionStats,
} from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useFocus } from './hooks/useFocus.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import * as fs from 'fs';
import * as path from 'path';
import { UpdateNotification } from './components/UpdateNotification.js';
import { checkForUpdates } from './utils/updateCheck.js';
import ansiEscapes from 'ansi-escapes';
import { OverflowProvider } from './contexts/OverflowContext.js';
import { ShowMoreLines } from './components/ShowMoreLines.js';
import { PrivacyNotice } from './privacy/PrivacyNotice.js';

type ApprovalRequest = {
  message: string;
  onApprove: () => void;
  onDeny: () => void;
};

const MAX_CONTEXT_TOKENS = 4096;

function findFileRecursive(
  startPath: string,
  filter: string,
): string | null {
  const ignoreDirs = ['node_modules', '.git', 'dist', 'build'];
  let foundPath: string | null = null;

  function search(currentPath: string) {
    if (foundPath) return;
    try {
      const files = fs.readdirSync(currentPath);
      for (const file of files) {
        if (foundPath) return;
        const newPath = path.join(currentPath, file);
        try {
          const stat = fs.lstatSync(newPath);
          if (stat.isDirectory() && !ignoreDirs.includes(file)) {
            search(newPath);
          } else if (path.basename(newPath) === filter) {
            foundPath = newPath;
            return;
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  search(startPath);
  return foundPath;
}

const CTRL_EXIT_PROMPT_DURATION_MS = 1000;

interface AppProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
}

export const AppWrapper = (props: AppProps) => (
  <SessionStatsProvider>
    <App {...props} />
  </SessionStatsProvider>
);

const App = ({ config, settings, startupWarnings = [], version }: AppProps) => {
  const isFocused = useFocus();
  useBracketedPaste();
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const { stdout } = useStdout();
  const { stdin, setRawMode } = useStdin();
  const nightly = version.includes('nightly');

  useEffect(() => {
    checkForUpdates().then(setUpdateMessage);
  }, []);

  const { history, addItem, clearItems, loadHistory } = useHistory();

  // All original state is restored here
  const {
    consoleMessages,
    handleNewMessage,
    clearConsoleMessages: clearConsoleMessagesState,
  } = useConsoleMessages();
  const { stats: sessionStats } = useSessionStats();
  const [staticKey, setStaticKey] = useState(0);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState<number>(0);
  const [corgiMode, setCorgiMode] = useState(false);
  const [shellModeActive, setShellModeActive] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] = useState<boolean>(false);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [quittingMessages, setQuittingMessages] = useState<HistoryItem[] | null>(null);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);

  // New state for LM Studio integration
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState(StreamingState.Idle);
  const [isAutopilot, setIsAutopilot] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    async function fetchModels() {
      try {
        const response = await fetch('http://127.0.0.1:1234/v1/models');
        if (!response.ok) throw new Error('LM Studio server not found.');
        const data = await response.json();
        const availableModels = data.data || [];
        setModels(availableModels);
        if (availableModels.length > 0) setSelectedModel(availableModels[0].id);
      } catch (e) {
        addItem({ type: MessageType.ERROR, text: `Could not connect to LM Studio at http://127.0.0.1:1234. Please ensure the server is running.` }, Date.now());
      }
    }
    fetchModels();
  }, [addItem]);

  const sendQueryToModel = useCallback(
    async (promptToSend: string, originalPrompt: string) => {
      if (!selectedModel) {
        addItem({ type: MessageType.ERROR, text: 'Error: No local model is selected.' }, Date.now());
        return;
      }
      if (history.at(-1)?.text !== originalPrompt) {
        addItem({ type: MessageType.USER, text: originalPrompt }, Date.now());
      }
      setStreamingState(StreamingState.Responding);
      try {
        const url = 'http://127.0.0.1:1234/v1/chat/completions';
        const requestBody = { model: selectedModel, messages: [{ role: 'user', content: promptToSend }] };
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000);
        const apiResponse = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), keepalive: false, signal: controller.signal });
        clearTimeout(timeoutId);
        if (!apiResponse.ok) throw new Error(`API request failed: ${await apiResponse.text()}`);
        const responseData = await apiResponse.json();
        const responseText = responseData.choices[0].message.content;
        addItem({ type: MessageType.GEMINI, text: responseText }, Date.now());
      } catch (error) {
        addItem({ type: MessageType.ERROR, text: `Error connecting to local model: ${(error as Error).message}` }, Date.now());
      } finally {
        setStreamingState(StreamingState.Idle);
      }
    },
    [selectedModel, addItem, history],
  );

  const submitQuery = useCallback(
    async (prompt: string) => {
      const filePathRegex = /([\w.-]+\.[\w]+)/g;
      const filePaths = prompt.match(filePathRegex);
      if (filePaths && filePaths.length > 0) {
        const fileName = filePaths[0];
        const fullPath = findFileRecursive(process.cwd(), fileName);
        let enrichedPrompt: string;
        if (fullPath) {
          const maxChars = MAX_CONTEXT_TOKENS * 4;
          const baseTemplate = `The user wants me to do the following: "${prompt}". I have found the relevant file at "${fullPath}", and its content is:\n\`\`\`\n{CONTENT}\n\`\`\`\nPlease proceed.`;
          const overhead = baseTemplate.length - '{CONTENT}'.length;
          const availableChars = maxChars - overhead;
          let fileContent = fs.readFileSync(fullPath, 'utf-8');
          if (fileContent.length > availableChars) {
            fileContent = fileContent.substring(0, availableChars);
            addItem({ type: MessageType.INFO, text: `⚠️ Warning: The file "${fileName}" was truncated.` }, Date.now());
          }
          enrichedPrompt = baseTemplate.replace('{CONTENT}', fileContent);
        } else {
          enrichedPrompt = `The user mentioned "${fileName}", but I could not find it. Inform the user the file was not found.`;
        }
        const proceed = () => sendQueryToModel(enrichedPrompt, prompt);
        if (isAutopilot) {
          addItem({ type: MessageType.INFO, text: `Autopilot ON. ${fullPath ? `Reading file: ${fullPath}` : `Could not find file: ${fileName}`}` }, Date.now());
          proceed();
        } else {
          setApprovalRequest({
            message: `I need to access the file system to find "${fileName}". Proceed? (Y/n)`,
            onApprove: () => { setApprovalRequest(null); proceed(); },
            onDeny: () => { setApprovalRequest(null); addItem({ type: MessageType.INFO, text: 'Action cancelled.' }, Date.now()); },
          });
        }
      } else {
        sendQueryToModel(prompt, prompt);
      }
    },
    [sendQueryToModel, isAutopilot, addItem],
  );

  useInput((input, key) => {
    if (approvalRequest) {
      if (key.return || input.toLowerCase() === 'y') approvalRequest.onApprove();
      else if (input.toLowerCase() === 'n') approvalRequest.onDeny();
    }
  }, { isActive: !!approvalRequest });

  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout]);

  const openPrivacyNotice = useCallback(() => setShowPrivacyNotice(true), []);
  const errorCount = useMemo(() => consoleMessages.filter((msg) => msg.type === 'error').length, [consoleMessages]);

  const { openThemeDialog } = useThemeCommand(settings, setThemeError, addItem);
  const { openAuthDialog } = useAuthCommand(settings, setAuthError, config);
  const { openEditorDialog } = useEditorSettings(settings, setEditorError, addItem);
  const toggleCorgiMode = useCallback(() => setCorgiMode((prev) => !prev), []);

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
  } = useSlashCommandProcessor(
    config,
    settings,
    addItem,
    clearItems,
    loadHistory,
    refreshStatic,
    setShowHelp,
    setDebugMessage,
    openThemeDialog,
    openAuthDialog,
    openEditorDialog,
    toggleCorgiMode,
    setQuittingMessages,
    openPrivacyNotice,
  );

  const handleFinalSubmit = useCallback((submittedValue: string) => {
    const trimmedValue = submittedValue.trim();
    if (trimmedValue.length > 0) submitQuery(trimmedValue);
  }, [submitQuery]);

  const { elapsedTime, currentLoadingPhrase } = useLoadingIndicator(streamingState);
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  const isInputActive = streamingState === StreamingState.Idle && !approvalRequest;
  const handleClearScreen = useCallback(() => {
    clearItems();
    clearConsoleMessagesState();
    console.clear();
    refreshStatic();
  }, [clearItems, clearConsoleMessagesState, refreshStatic]);

  const mainControlsRef = useRef<DOMElement>(null);
  useEffect(() => {
    if (mainControlsRef.current) setFooterHeight(measureElement(mainControlsRef.current).height);
  }, [terminalHeight, consoleMessages, showErrorDetails]);
  
  const branchName = useGitBranchName(config.getTargetDir());
  const mainAreaWidth = Math.floor(terminalWidth * 0.9);
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);
  const widthFraction = 0.9;
  const inputWidth = Math.max(20, Math.floor(terminalWidth * widthFraction) - 3);
  const suggestionsWidth = Math.max(60, Math.floor(terminalWidth * 0.8));

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath: (filePath: string) => fs.existsSync(filePath),
    shellModeActive,
  });

  const handleExit = useCallback(
    (pressedOnce: boolean, setPressedOnce: (value: boolean) => void, timerRef: React.MutableRefObject<NodeJS.Timeout | null>) => {
      if (pressedOnce) {
        if (timerRef.current) clearTimeout(timerRef.current);
        handleSlashCommand('/quit');
      } else {
        setPressedOnce(true);
        timerRef.current = setTimeout(() => {
          setPressedOnce(false);
          timerRef.current = null;
        }, CTRL_EXIT_PROMPT_DURATION_MS);
      }
    },
    [handleSlashCommand],
  );

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
    else if (key.ctrl && input === 'a') {
      const newMode = !isAutopilot;
      setIsAutopilot(newMode);
      addItem({ type: MessageType.INFO, text: `Autopilot mode is now ${newMode ? 'ON' : 'OFF'}.` }, Date.now());
    }
  });

  const logger = useLogger();
  const [userMessages, setUserMessages] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const past = (await logger?.getPreviousUserMessages()) || [];
      const current = history.filter((item): item is HistoryItem & { type: 'user' } => item.type === 'user').map(item => item.text).reverse();
      const combined = [...current, ...past];
      const deduplicated: string[] = [];
      if (combined.length > 0) {
        deduplicated.push(combined[0]);
        for (let i = 1; i < combined.length; i++) {
          if (combined[i] !== combined[i-1]) deduplicated.push(combined[i]);
        }
      }
      setUserMessages(deduplicated.reverse());
    })();
  }, [history, logger]);
  
  return (
    <StreamingContext.Provider value={streamingState}>
      <Box flexDirection="column" marginBottom={1} width="90%">
        {updateMessage && <UpdateNotification message={updateMessage} />}
        <Static items={history}>
          {(item) => <HistoryItemDisplay key={item.id} item={item} config={config} terminalWidth={mainAreaWidth} isPending={false} />}
        </Static>
        <OverflowProvider>
          <Box flexDirection="column">
            {pendingSlashCommandHistoryItems.map((item, i) => (
              <HistoryItemDisplay key={i} item={{ ...item, id: 0 }} config={config} terminalWidth={mainAreaWidth} isPending={true} isFocused={true} />
            ))}
            <ShowMoreLines constrainHeight={constrainHeight} />
          </Box>
        </OverflowProvider>
        {showHelp && <Help commands={slashCommands} />}
        <Box marginTop={1}>
          <Text color={Colors.Foreground}>Active Model: </Text>
          <Text color={Colors.AccentBlue}>{selectedModel || 'Loading models...'}</Text>
          <Text> | </Text>
          <Text color={Colors.Foreground}>Autopilot (Ctrl+A): </Text>
          <Text color={isAutopilot ? Colors.AccentGreen : Colors.AccentRed}>{isAutopilot ? 'ON' : 'OFF'}</Text>
        </Box>
        <Box flexDirection="column" ref={mainControlsRef}>
          {approvalRequest && (
            <Box borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
              <Text color={Colors.AccentYellow}>{approvalRequest.message}</Text>
            </Box>
          )}
          <LoadingIndicator currentLoadingPhrase={currentLoadingPhrase} elapsedTime={elapsedTime} />
          {isInputActive && (
            <InputPrompt
              buffer={buffer}
              inputWidth={inputWidth}
              suggestionsWidth={suggestionsWidth}
              onSubmit={handleFinalSubmit}
              userMessages={userMessages}
              onClearScreen={handleClearScreen}
              config={config}
              slashCommands={slashCommands}
              commandContext={commandContext}
              shellModeActive={shellModeActive}
              setShellModeActive={setShellModeActive}
              focus={isFocused}
            />
          )}
          <Footer
            model={selectedModel || 'local'}
            targetDir={config.getTargetDir()}
            debugMode={config.getDebugMode()}
            branchName={branchName}
            debugMessage={debugMessage}
            corgiMode={corgiMode}
            errorCount={errorCount}
            showErrorDetails={showErrorDetails}
            promptTokenCount={sessionStats.lastPromptTokenCount}
            nightly={nightly}
          />
        </Box>
      </Box>
    </StreamingContext.Provider>
  );
};