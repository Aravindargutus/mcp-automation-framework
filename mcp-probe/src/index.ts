/**
 * MCP Probe — public API exports.
 */

// Config
export { MCPProbeConfigSchema, type MCPProbeConfig, type ServerConfig, type LLMJudgeConfig } from './config/schema.js';
export { loadConfig, validateConfig } from './config/loader.js';

// Client
export { MCPProbeClient, type DiscoveredServer, type DiscoveredTool, type ToolCallTrace } from './client/mcp-client.js';
export { RawMCPClient } from './client/raw-client.js';
export { TaskClient } from './client/task-client.js';

// Transport
export { StdioTransport } from './transport/stdio.js';
export { HttpTransport, HttpAuthRequiredError } from './transport/http.js';
export { SessionManager } from './transport/session.js';
export type { MCPTransport } from './transport/types.js';

// Suite
export type { TestSuite, TestCase, TestRunContext } from './suite/types.js';
export { AssertHelper } from './suite/types.js';
export { TestSuiteRegistry } from './suite/registry.js';
export { ProtocolSuite } from './suite/protocol/index.js';
export { SchemaSuite } from './suite/schema/index.js';
export { AIEvaluationSuite } from './suite/ai-evaluation/index.js';

// Plugin
export type { MCPProbePlugin, CustomAssertion, TestResult, SuiteResult } from './plugin/types.js';

// Reporter
export type { MCPProbeReport, ServerReport, ScoreCard } from './reporter/schema.js';

// Runner
export { run } from './runner/runner.js';
