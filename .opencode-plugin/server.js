import { createPlugin } from '@opencode/plugin';
import * as fs from 'fs';
import * as path from 'path';

import {
  compact,
  reductionRatio,
} from '../dist/compact.js';
import { JevClient } from '../dist/client.js';

// Default configuration
const DEFAULT_CONFIG = {
  apiKey: undefined,
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: 'jev-latest',
  goal: undefined,
};

/** Extract text from OpenCode/Claude message format */
function extractMessageText(message) {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    // Handle content array (text parts, tool results, etc.)
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('\n');
  }
  return '';
}

/** Convert OpenCode message to fast-jev-compaction Message format */
function convertOpenCodeMessage(message) {
  const toolUses = [];
  const toolResults = [];

  // Handle tool calls in assistant messages
  if (message.toolCalls && Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      toolUses.push({
        tool_use_id: call.id,
        tool: call.function?.name || call.tool,
        input: typeof call.function?.arguments === 'string'
          ? JSON.parse(call.function?.arguments || '{}')
          : call.function?.arguments || {},
      });
    }
  }

  // Extract tool results from message content
  if (Array.isArray(message.content)) {
    // Tool results may be embedded in content
    for (const content of message.content) {
      if (content.type === 'tool_result') {
        toolResults.push({
          tool_use_id: content.tool_use_id,
          text: content.text || JSON.stringify(content, null, 2),
        });
      }
    }
  }

  return {
    role: message.role,
    text: extractMessageText(message),
    toolUses,
    toolResults,
  };
}

/** Convert OpenCode transcript to fast-jev-compaction format */
function parseOpenCodeTranscript(messages) {
  return messages.map(convertOpenCodeMessage);
}

/** Calculate reduction ratio */
function calcReductionRatio(result) {
  const { stats } = result;
  return stats.charsBefore === 0 ? 0 : (stats.charsBefore - stats.charsAfter) / stats.charsBefore;
}

/** Get plugin data directory */
function getDataDir() {
  return path.join(process.cwd(), '.codex', 'fast-jev-compaction');
}

/** Write decisions log */
function writeDecisionsLog(sessionID, trigger, result) {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const logPath = path.join(dataDir, 'jev-decisions.jsonl');
  const stats = result.stats;
  const ratio = calcReductionRatio(result);

  const logEntry = JSON.stringify({
    session_id: sessionID,
    timestamp: Date.now(),
    trigger,
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
}

export default createPlugin(({ register }) => {
  register('session.compaction', async (event) => {
    // Get configuration from plugin options
    const config = { ...DEFAULT_CONFIG };

    // Get API key - try options first, then environment
    const apiKey = config.apiKey || process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      console.log('fast-jev-compaction: TYPESAFE_API_KEY not configured');
      return;
    }

    // Check if we have enough messages
    if (!event.messages || event.messages.length < 4) {
      return;
    }

    // Parse OpenCode messages into fast-jev format
    let messages;
    try {
      messages = parseOpenCodeTranscript(event.messages);
    } catch (error) {
      console.log(`fast-jev-compaction: Failed to parse transcript (${error.message})`);
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
      console.log(`fast-jev-compaction: Compaction failed (${error.message})`);
      return;
    }

    // Calculate reduction ratio
    const ratio = calcReductionRatio(result);

    // Check if we have meaningful reduction
    if (ratio < config.minReductionRatio) {
      console.log(`fast-jev-compaction: Insufficient reduction (${Math.round(ratio * 100)}%), falling back to built-in`);
      return;
    }

    // Write decisions log
    writeDecisionsLog(event.sessionID, 'auto', result);

    // Build the compacted messages
    const compactedMessages = result.messages.map(m => ({
      ...m,
      // Remove the tool input from tool uses when result is dropped
      toolUses: m.toolUses.map(tu => {
        const decision = result.decisions.find(d => d.id === tu.tool_use_id);
        if (!decision || decision.action === 'drop_call') {
          return { ...tu, input: undefined };
        }
        return tu;
      }),
    }));

    // Replace messages with compacted version
    event.messages = compactedMessages;

    // Skip the model call by setting result
    event.result = {
      summary: `[... Jev compaction applied: ${Math.round(ratio * 100)}% reduction ...]`,
    };

    console.log(`fast-jev-compaction: ${Math.round(ratio * 100)}% reduction (${result.stats.messagesAfter}/${result.stats.messagesBefore} messages)`);
  });

  // Also register for context hook to log decisions
  register('session.context', async (event) => {
    // This runs for every model request - no action needed for compaction plugin
  });
});