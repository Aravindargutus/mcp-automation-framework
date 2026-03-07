/**
 * Security Test Suite — always-on security testing for MCP servers.
 *
 * Tests for prompt injection, credential exposure, tool poisoning,
 * input sanitization, and auth enforcement. Unlike the performance
 * suite, security tests are enabled by default because security
 * vulnerabilities are critical to detect.
 *
 * Users can exclude via suites.exclude: ['security'] in config.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import type { TestCase, TestSuite, TestRunContext } from '../types.js';
import { generatePromptInjectionTests } from './prompt-injection.js';
import { generateCredentialExposureTests } from './credential-exposure.js';
import { generateToolPoisoningTests } from './tool-poisoning.js';
import { generateInputSanitizationTests } from './input-sanitization.js';
import { generateAuthTests } from './auth-tests.js';

export class SecuritySuite implements TestSuite {
  name = 'security';
  description = 'MCP security tests: prompt injection, credential exposure, tool poisoning, input sanitization, auth enforcement';
  tags = ['security', 'required'];

  isApplicable(_discovered: DiscoveredServer): boolean {
    // Security tests always run — too critical to skip
    return true;
  }

  generateTests(discovered: DiscoveredServer, _serverConfig: ServerConfig): TestCase[] {
    return [
      ...generatePromptInjectionTests(discovered),
      ...generateCredentialExposureTests(discovered),
      ...generateToolPoisoningTests(discovered),
      ...generateInputSanitizationTests(discovered),
      ...generateAuthTests(discovered),
    ];
  }

  async setup(_context: TestRunContext): Promise<void> {
    // No setup needed — security tests are self-contained
  }

  async teardown(_context: TestRunContext): Promise<void> {
    // No teardown needed
  }
}
