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
} from '../src/compact.js';
import { JevClient } from '../src/client.js';
import type { Message } from '../src/types.js';

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
  const projectRoot = process.cwd();
  return path.join(projectRoot, '.codex', 'fast-jev-compaction');
}

/** Parse transcript file from Codex */
function parseTranscript(transcriptPath: string): Message[] {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');
    
    const messages: Message[] = [];
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const entry = JSON.parse(line);
        
        if (entry.role && entry.content !== undefined) {
          const role = entry.role as 'user' | 'assistant';
          const text = typeof entry.content === 'string' ? entry.content : '';
          
          if (role === 'assistant') {
            // Assistant message with potential tool uses
            messages.push({ role, text, toolUses: [], toolResults: [] });
          } else if (role === 'user') {
            // User message with potential tool results
            const toolResults = entry.tool_use_id 
              ? [{ tool_use_id: entry.tool_use_id, text, isError: entry.isError }]
              : undefined;
            messages.push({ 
              role, 
              text, 
              toolUses: [], 
              ...(toolResults ? { toolResults } : {}) 
            });
          }
        }
      } catch {
        // Skip malformed lines
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
  const ratio = reductionRatio(result);
  
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