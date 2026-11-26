#!/usr/bin/env tsx

/**
 * PreCompact hook for Codex CLI
 * 
 * Runs before Codex's built-in compaction to perform Jev-guided pruning.
 * Writes decisions to a log file that SessionStart(source="compact") will read.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  compact,
  reductionRatio,
} from './src/compact.ts';
import { JevClient } from './src/client.ts';
import type { Message, ToolUse, ToolResult } from './src/types.ts';

type PreCompactInput = {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: string;
  trigger: 'manual' | 'auto';
  model: string;
};

type HookConfig = {
  apiKey?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  goal?: string;
};

const DEFAULT_CONFIG: HookConfig = {
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: 'jev-latest',
};

/** Resolve config from plugin options */
function getConfig(): HookConfig {
  const configJson = process.env.CODEX_HOOK_CONFIG;
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_CONFIG;
}

/** Get plugin data directory */
function getDataDir(): string {
  const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    return path.join(path.dirname(pluginRoot), '.codex', 'fast-jev-compaction');
  }
  // Fallback to system temp
  return '/tmp/fast-jev-compaction';
}

// Track tool calls in-flight
const pendingCalls = new Map<string, { 
  tool: string; 
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  messageIndex: number;
}>();

/** Extract tool result text from Codex output format */
function extractOutputText(output: Array<{ type: string; text?: string }>): string {
  return output
    .filter((o): o is { type: string; text: string } => o.type === 'input_text' && o.text)
    .map((o) => o.text)
    .join('\n');
}

/** Parse Codex transcript file into Messages */
function parseTranscript(transcriptPath: string): Message[] {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    const messages: Message[] = [];
    
    // Track current message builder state
    let currentRole: 'user' | 'assistant' | null = null;
    let currentText = '';
    let currentToolUses: ToolUse[] = [];
    let currentToolResults: ToolResult[] = [];

    // Track tool calls by call_id for matching with results
    const toolCallMap = new Map<string, { tool: string; input: Record<string, unknown> }>();
    const toolCallToMsgIdx = new Map<string, number>();

    for (const line of lines) {
      if (!line.trim()) continue;

      JSON.parse(line); // Validate JSON but don't process yet
    }

    // First pass: collect all messages and tool calls
    for (const line of lines) {
      if (!line.trim()) continue;
      
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Skip metadata entries
      if (entry.type === 'event_msg' || entry.type === 'token_usage_record') continue;

      // Check for response_item (messages, tool calls, tool results)
      if (entry.type === 'response_item') {
        const payload = entry.payload;
        
        if (payload.type === 'message') {
          // User message in Codex format
          const role = payload.role === 'user' ? 'user' : 'assistant';
          const text = payload.content || '';
          
          messages.push({
            role,
            text,
            toolUses: [],
            toolResults: [],
          });

        } else if (payload.type === 'custom_tool_call') {
          // Tool call from assistant
          toolCallMap.set(payload.call_id, {
            tool: payload.name,
            input: payload.input || {},
          });
          toolCallToMsgIdx.set(payload.call_id, messages.length);
          
          // Add a message for the assistant with tool use
          messages.push({
            role: 'assistant',
            text: '',
            toolUses: [{
              tool_use_id: payload.call_id,
              tool: payload.name,
              input: payload.input || {},
            }],
            toolResults: [],
          });

        } else if (payload.type === 'custom_tool_call_output') {
          // Tool result from system
          const callId = payload.call_id;
          const toolInfo = toolCallMap.get(callId);
          const msgIdx = toolCallToMsgIdx.get(callId);
          
          if (toolInfo && msgIdx !== undefined) {
            const text = extractOutputText(payload.output || []);
            
            // Update the associated assistant message to include tool text
            const toolUse = { ...messages[msgIdx].toolUses[0], text };
            messages[msgIdx].toolUses[0] = toolUse;
            
            // Add user message with tool result
            messages.push({
              role: 'user',
              text: '',
              toolUses: [],
              toolResults: [{
                tool_use_id: callId,
                text,
              }],
            });
            
            // Cleanup to prevent duplicates
            toolCallMap.delete(callId);
            toolCallToMsgIdx.delete(callId);
          }
        }
      }
    }

    return messages;
  } catch (error) {
    throw new Error(`Failed to parse transcript: ${error}`);
  }
}

/** Get API key */
function getApiKey(config: HookConfig): string | undefined {
  return config.apiKey || process.env.TYPESAFE_API_KEY;
}

/** Calculate reduction ratio */
function calcReductionRatio(result: { stats: { charsBefore: number; charsAfter: number } }): number {
  const { stats } = result;
  return stats.charsBefore === 0 ? 0 : (stats.charsBefore - stats.charsAfter) / stats.charsBefore;
}

/** Main PreCompact handler */
async function handlePreCompact(input: PreCompactInput): Promise<void> {
  const config = getConfig();

  // Get API key
  const apiKey = getApiKey(config);
  if (!apiKey) {
    console.log('fast-jev-compaction: TYPESAFE_API_KEY not configured');
    return;
  }

  // Check transcript path
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) {
    console.log('fast-jev-compaction: no transcript path available');
    return;
  }

  // Read transcript
  let messages: Message[];
  try {
    messages = parseTranscript(input.transcript_path);
  } catch (error) {
    console.log(`fast-jev-compaction: Failed to read transcript (${(error as Error).message})`);
    return;
  }

  // Run compaction
  const client = new JevClient({ apiKey, model: config.model });

  let result;
  try {
    result = await compact(messages, client, {
      goal: config.goal,
      keepThreshold: config.keepThreshold,
      preserveRecentMessages: config.preserveRecentMessages,
      maxStateTokens: config.maxStateTokens,
      maxRequestTokens: config.maxRequestTokens,
      truncateHeadChars: config.truncateHeadChars,
    });
  } catch (error) {
    console.log(`fast-jev-compaction: Compaction failed (${(error as Error).message})`);
    return;
  }

  // Write decisions log
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const logPath = path.join(dataDir, 'jev-decisions.jsonl');
  const stats = result.stats;
  const ratio = calcReductionRatio(result);

  const logEntry = JSON.stringify({
    session_id: input.session_id,
    timestamp: Date.now(),
    trigger: input.trigger,
    messagesBefore: stats.messagesBefore,
    messagesAfter: stats.messagesAfter,
    charsBefore: stats.charsBefore,
    charsAfter: stats.charsAfter,
    reductionRatio: ratio,
    stateTokens: stats.stateTokens,
    stateStage: stats.stateStage,
    requests: stats.requests,
    decisions: result.decisions.map(d => ({
      id: d.id,
      tool: d.tool,
      action: d.action,
      reason: d.reason,
      keepCall: d.keepCall,
      keepResult: d.keepResult,
    })),
  });

  fs.appendFileSync(logPath, logEntry + '\n');

  console.log(`fast-jev-compaction: ${Math.round(ratio * 100)}% reduction (${stats.messagesAfter}/${stats.messagesBefore} messages)`);
}

// Run handler
const inputJson = fs.readFileSync('/dev/stdin', 'utf-8');
const input = JSON.parse(inputJson) as PreCompactInput;

handlePreCompact(input).catch(error => {
  console.log(`fast-jev-compaction: Hook error (${(error as Error).message})`);
  process.exit(0); // Don't fail the hook, let Codex use built-in compaction
});