#!/usr/bin/env tsx

/**
 * SessionStart hook for Codex CLI
 * 
 * Fires when session starts after compaction (source="compact").
 * Reads the Jev decisions log and injects it as additional context.
 */

import * as fs from 'fs';
import * as path from 'path';

type SessionStartInput = {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: string;
  source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  turn_id: string;
  model: string;
};

type HookConfig = {
  compactAtPercent: number;
  minReductionRatio: number;
};

const DEFAULT_CONFIG: HookConfig = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
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

/** Read latest decisions log for this session */
function readDecisionsLog(sessionId: string): Record<string, unknown> | null {
  const dataDir = getDataDir();
  const logPath = path.join(dataDir, 'jev-decisions.jsonl');
  
  if (!fs.existsSync(logPath)) return null;
  
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    
    // Find the most recent entry for this session
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        
        if (entry.session_id === sessionId) {
          return entry;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist or can't read
  }
  
  return null;
}

/** Format decisions for additional context */
function formatDecisionsContext(entry: Record<string, unknown>, sessionId: string): string {
  const ratio = (entry as any).reductionRatio || 0;
  const messagesBefore = (entry as any).messagesBefore || 0;
  const messagesAfter = (entry as any).messagesAfter || 0;
  const charsBefore = (entry as any).charsBefore || 0;
  const charsAfter = (entry as any).charsAfter || 0;
  const decisions = (entry as any).decisions || [];
  
  const lines = [
    `## Fast-JEV-Compaction Decision Log`,
    ``,
    `Session: ${sessionId}`,
    `Reduction: ${Math.round(ratio * 100)}% (${messagesAfter}/${messagesBefore} messages, ${charsAfter}/${charsBefore} chars)`,
    ``,
    `Tool decisions (what Jev decided to drop):`,
    ``,
  ];
  
  const droppedCalls = decisions.filter((d: any) => d.action === 'drop_call');
  const droppedResults = decisions.filter((d: any) => d.action === 'drop_result');
  
  if (droppedCalls.length === 0 && droppedResults.length === 0) {
    lines.push('None - all kept');
  } else {
    for (const d of [...droppedCalls, ...droppedResults]) {
      const status = d.action === 'drop_call' 
        ? `call ${d.id} (${d.tool}) dropped` 
        : `result of ${d.id} (${d.tool}) truncated`;
      lines.push(`• ${status}: keepCall=${d.keepCall.toFixed(2)}, keepResult=${d.keepResult.toFixed(2)}`);
    }
  }
  
  lines.push('`');
  return lines.join('\n');
}

/** Main SessionStart handler */
function handleSessionStart(input: SessionStartInput): string | null {
  // Only handle compaction source
  if (input.source !== 'compact') {
    return null;
  }
  
  // Read decisions log
  const entry = readDecisionsLog(input.session_id);
  if (!entry) {
    return null;
  }
  
  // Format and return additional context
  return formatDecisionsContext(entry, input.session_id);
}

// Run handler
const inputJson = fs.readFileSync('/dev/stdin', 'utf-8');
const input = JSON.parse(inputJson) as SessionStartInput;

const context = handleSessionStart(input);
if (context) {
  console.log(JSON.stringify({ additionalContext: context }));
}