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
import { UpdateNotification } from './components/UpdateNotification.js';
import { checkForUpdates } from './utils/updateCheck.js';
import ansiEscapes from 'ansi-escapes';
import { OverflowProvider } from './contexts/OverflowContext.js';
import { ShowMoreLines } from './components/ShowMoreLines.js';
import { PrivacyNotice } from './privacy/PrivacyNotice.js';

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
  const nightly = version.includes('nightly');

  useEffect(() => {
    checkForUpdates().then(setUpdateMessage);
  }, []);

  const { history, addItem, clearItems, loadHistory } = useHistory();

  // =========================================================================
  // START: LM STUDIO MODIFICATIONS
  // =========================================================================

  const [models, setModels] = useState<{ id: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [streamingState, setStreamingState] = useState(StreamingState.Idle);

  useEffect(() => {
    async function fetchModels() {
      try {
        const response = await fetch('http://localhost:1234/v1/models');
        if (!response.ok) {
          throw new Error('LM Studio server not found or not responding.');
        }
        const data = await response.json();
        const availableModels = data.data || [];
        setModels(availableModels);
        if (availableModels.length > 0) {
          setSelectedModel(availableModels[0].id);
        }
      } catch (e) {
        addItem(
          {
            type: MessageType.ERROR,
            text: `Could not connect to LM Studio at http://localhost:1234. Please ensure the server is running.`,
          },
          Date.now(),
        );
      }
    }
    fetchModels();
  }, []);

  const submitQuery = useCallback(
    async (prompt: string) => {
      if (!selectedModel) {
        addItem(
          {
            type: MessageType.ERROR,
            text: 'Error: No local model is selected or available.',
          },
          Date.now(),
        );
        return;
      }

      addItem({ type: MessageType.USER, text: prompt }, Date.now());
      setStreamingState(StreamingState.Responding);

      try {
        const url = 'http://localhost:1234/v1/chat/completions';
        const requestBody = {
          model: selectedModel,
          messages: [{ role: 'user', content: prompt }],
        };

        const apiResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!apiResponse.ok) {
          const errorText = await apiResponse.text();
          throw new Error(
            `Request failed with status ${apiResponse.status}: ${errorText}`,
          );
        }

        const responseData = await apiResponse.json();
        const responseText = responseData.choices[0].message.content;

        addItem(
          { type: MessageType.GEMINI, text: responseText },
          Date.now(),
        );
      } catch (error) {
        addItem(
          {
            type: MessageType.ERROR,
            text: `Error connecting to local model: ${(error as Error).message}`,
          },
          Date.now(),
        );
      } finally {
        setStreamingState(StreamingState.Idle);
      }
    },
    [selectedModel, addItem],
  );

  // =========================================================================
  // END: LM STUDIO MODIFICATIONS
  // =========================================================================

  const {
    consoleMessages,
    handleNewMessage,
    clearConsoleMessages: clearConsoleMessagesState,
  } = useConsoleMessages();

  useEffect(() => {
    const consolePatcher = new ConsolePatcher({
      onNewMessage: handleNewMessage,
      debugMode: config.getDebugMode(),
    });
    consolePatcher.patch();
    registerCleanup(consolePatcher.cleanup);
  }, [handleNewMessage, config]);

  const { stats: sessionStats } = useSessionStats();
  const [staticKey, setStaticKey] = useState(0);
  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout]);

  const [debugMessage, setDebugMessage] = useState<string>('');
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState<number>(0);
  const [corgiMode, setCorgiMode] = useState(false);
  const [shellModeActive, setShellModeActive] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);
  const [activeFile, setActiveFile] = useState<ActiveFile | undefined>();

  useEffect(() => {
    const unsubscribe = ideContext.subscribeToActiveFile(setActiveFile);
    setActiveFile(ideContext.getActiveFileContext());
    return unsubscribe;
  }, []);

  const openPrivacyNotice = useCallback(() => {
    setShowPrivacyNotice(true);
  }, []);

  const errorCount = useMemo(
    () => consoleMessages.filter((msg) => msg.type === 'error').length,
    [consoleMessages],
  );

  const { openThemeDialog } = useThemeCommand(settings, setThemeError, addItem);

  const { openAuthDialog } = useAuthCommand(
    settings,
    setAuthError,
    config,
  );

  const { openEditorDialog } = useEditorSettings(
    settings,
    setEditorError,
    addItem,
  );

  const toggleCorgiMode = useCallback(() => {
    setCorgiMode((prev) => !prev);
  }, []);

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

  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      const trimmedValue = submittedValue.trim();
      if (trimmedValue.length > 0) {
        submitQuery(trimmedValue);
      }
    },
    [submitQuery],
  );

  const { elapsedTime, currentLoadingPhrase } =
    useLoadingIndicator(streamingState);

  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();

  const isInputActive = streamingState === StreamingState.Idle;

  const handleClearScreen = useCallback(() => {
    clearItems();
    clearConsoleMessagesState();
    console.clear();
    refreshStatic();
  }, [clearItems, clearConsoleMessagesState, refreshStatic]);

  const mainControlsRef = useRef<DOMElement>(null);
  const pendingHistoryItemRef = useRef<DOMElement>(null);

  useEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      setFooterHeight(fullFooterMeasurement.height);
    }
  }, [terminalHeight, consoleMessages, showErrorDetails]);

  const staticExtraHeight = 3;
  const availableTerminalHeight = useMemo(
    () => terminalHeight - footerHeight - staticExtraHeight,
    [terminalHeight, footerHeight],
  );

  const filteredConsoleMessages = useMemo(() => {
    if (config.getDebugMode()) {
      return consoleMessages;
    }
    return consoleMessages.filter((msg) => msg.type !== 'debug');
  }, [consoleMessages, config]);

  const branchName = useGitBranchName(config.getTargetDir());

  const mainAreaWidth = Math.floor(terminalWidth * 0.9);
  const debugConsoleMaxHeight = Math.floor(Math.max(terminalHeight * 0.2, 5));
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);

  const widthFraction = 0.9;
  const inputWidth = Math.max(
    20,
    Math.floor(terminalWidth * widthFraction) - 3,
  );
  const suggestionsWidth = Math.max(60, Math.floor(terminalWidth * 0.8));

  const { stdin, setRawMode } = useStdin();

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath: (filePath: string) => fs.existsSync(filePath),
    shellModeActive,
  });

  const handleExit = useCallback(
    (
      pressedOnce: boolean,
      setPressedOnce: (value: boolean) => void,
      timerRef: React.MutableRefObject<NodeJS.Timeout | null>,
    ) => {
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

  useInput((input: string, key: InkKeyType) => {
    if (!constrainHeight) setConstrainHeight(true);
    if (key.ctrl && input === 'o') setShowErrorDetails((prev) => !prev);
    if (key.ctrl && input === 't') setShowToolDescriptions((prev) => !prev);
    if (key.ctrl && (input === 'c' || input === 'C'))
      handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
    if (key.ctrl && (input === 'd' || input === 'D')) {
      if (buffer.text.length === 0)
        handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
    }
    if (key.ctrl && input === 's') setConstrainHeight(false);
  });

  const logger = useLogger();
  const [userMessages, setUserMessages] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const past = (await logger?.getPreviousUserMessages()) || [];
      const current = history
        .filter((item): item is HistoryItem & { type: 'user' } => item.type === 'user')
        .map((item) => item.text)
        .reverse();
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
        <Static
          key={staticKey}
          items={[
            <Box flexDirection="column" key="header">
              {!settings.merged.hideBanner && (
                <Header
                  terminalWidth={terminalWidth}
                  version={version}
                  nightly={nightly}
                />
              )}
              {!settings.merged.hideTips && <Tips config={config} />}
            </Box>,
            ...history.map((h) => (
              <HistoryItemDisplay
                terminalWidth={mainAreaWidth}
                availableTerminalHeight={staticAreaMaxItemHeight}
                key={h.id}
                item={h}
                isPending={false}
                config={config}
              />
            )),
          ]}
        >
          {(item) => item}
        </Static>
        <OverflowProvider>
          <Box ref={pendingHistoryItemRef} flexDirection="column">
            {pendingSlashCommandHistoryItems.map((item, i) => (
              <HistoryItemDisplay
                key={i}
                availableTerminalHeight={
                  constrainHeight ? availableTerminalHeight : undefined
                }
                terminalWidth={mainAreaWidth}
                item={{ ...item, id: 0 }}
                isPending={true}
                config={config}
                isFocused={true}
              />
            ))}
            <ShowMoreLines constrainHeight={constrainHeight} />
          </Box>
        </OverflowProvider>

        {showHelp && <Help commands={slashCommands} />}
        
        <Box>
          <Text color={Colors.Foreground}>Active Model: </Text>
          <Text color={Colors.AccentBlue}>
            {selectedModel || 'Loading models...'}
          </Text>
        </Box>

        {/* ========================================================================= */}
        {/* FINAL FIX: This entire block is simplified to always show the input      */}
        {/* ========================================================================= */}
        <Box flexDirection="column" ref={mainControlsRef}>
            <>
              <LoadingIndicator
                currentLoadingPhrase={currentLoadingPhrase}
                elapsedTime={elapsedTime}
              />
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
            </>
          <Footer
            model={selectedModel || 'local'}
            targetDir={config.getTargetDir()}
            debugMode={config.getDebugMode()}
            branchName={branchName}
            debugMessage={debugMessage}
            corgiMode={corgiMode}
            errorCount={errorCount}
            showErrorDetails={showErrorDetails}
            showMemoryUsage={
              config.getDebugMode() || config.getShowMemoryUsage()
            }
            promptTokenCount={sessionStats.lastPromptTokenCount}
            nightly={nightly}
          />
        </Box>
      </Box>
    </StreamingContext.Provider>
  );
};