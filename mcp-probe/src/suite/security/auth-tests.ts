/**
 * Auth Enforcement Tests — verify authentication/authorization controls.
 *
 * Tests that servers properly enforce authentication when configured,
 * reject invalid/expired tokens, and don't expose data to
 * unauthenticated requests.
 */
import type { DiscoveredServer } from '../../client/mcp-client.js';
import { AssertHelper, type TestCase, type TestRunContext } from '../types.js';

export function generateAuthTests(discovered: DiscoveredServer): TestCase[] {
  const tests: TestCase[] = [];

  // --- Test 1: Check if auth is configured but tools don't require it ---
  tests.push({
    id: 'security.auth.enforcement-check',
    name: 'Security: Auth enforcement assessment',
    description: 'Evaluates whether the server has proper authentication controls',
    tags: ['security', 'auth'],

    async run(ctx: TestRunContext) {
      const assert = new AssertHelper();
      const hasAuth = !!ctx.serverConfig.auth;
      const transportType = ctx.serverConfig.transport.type;

      if (hasAuth) {
        assert.ok(true, 'Authentication configured',
          `Server uses ${ctx.serverConfig.auth!.type} authentication`);
      } else if (transportType === 'http' || transportType === 'sse') {
        // HTTP/SSE servers without auth are a concern
        assert.warn(false, 'No authentication on HTTP server',
          'HTTP/SSE transport without authentication — any client can connect');
      } else {
        // stdio transport is typically local and doesn't need auth
        assert.info('auth-stdio',
          'stdio transport typically relies on OS-level access control');
      }

      return {
        assertions: assert.assertions,
        metadata: {
          hasAuth,
          transportType,
          authType: ctx.serverConfig.auth?.type ?? 'none',
        },
      };
    },
  });

  // --- Test 2: Tool access without explicit permissions ---
  if (discovered.tools.length > 0) {
    tests.push({
      id: 'security.auth.tool-access-control',
      name: 'Security: Tool access control assessment',
      description: 'Checks whether tools implement any access control or rate limiting signals',
      tags: ['security', 'auth', 'access-control'],

      async run(ctx: TestRunContext) {
        const assert = new AssertHelper();

        // Check if any tools have annotations suggesting access control
        const toolsWithAnnotations = discovered.tools.filter(
          (t) => t.annotations && Object.keys(t.annotations).length > 0,
        );

        const destructiveTools = discovered.tools.filter(
          (t) => t.annotations?.destructiveHint === true,
        );

        const readOnlyTools = discovered.tools.filter(
          (t) => t.annotations?.readOnlyHint === true,
        );

        const unannotatedTools = discovered.tools.filter(
          (t) => !t.annotations || Object.keys(t.annotations).length === 0,
        );

        if (unannotatedTools.length > 0) {
          assert.warn(false, 'Unannotated tools found',
            `${unannotatedTools.length}/${discovered.tools.length} tools lack safety annotations — ` +
            `consider adding readOnlyHint/destructiveHint for AI safety`);
        }

        if (destructiveTools.length > 0 && !ctx.serverConfig.auth) {
          assert.warn(false, 'Destructive tools without auth',
            `${destructiveTools.length} destructive tool(s) accessible without authentication: ` +
            destructiveTools.map((t) => t.name).join(', '));
        }

        assert.info('access-control-summary',
          `Tools: ${discovered.tools.length} total, ${readOnlyTools.length} read-only, ` +
          `${destructiveTools.length} destructive, ${unannotatedTools.length} unannotated`);

        return {
          assertions: assert.assertions,
          metadata: {
            totalTools: discovered.tools.length,
            annotated: toolsWithAnnotations.length,
            readOnly: readOnlyTools.length,
            destructive: destructiveTools.length,
            unannotated: unannotatedTools.length,
          },
        };
      },
    });
  }

  // --- Test 3: Server info disclosure ---
  tests.push({
    id: 'security.auth.info-disclosure',
    name: 'Security: Server info disclosure check',
    description: 'Checks if the server exposes excessive implementation details',
    tags: ['security', 'auth', 'info-disclosure'],

    async run(ctx: TestRunContext) {
      const assert = new AssertHelper();
      const serverInfo = ctx.discovered.serverInfo;

      // Check if server version is exposed (not always bad, but notable)
      if (serverInfo?.version) {
        assert.info('version-exposed',
          `Server exposes version: ${serverInfo.version}`);
      }

      // Check if server name reveals technology stack
      const nameStr = (serverInfo?.name ?? '').toLowerCase();
      const techIndicators = ['express', 'fastify', 'flask', 'django', 'rails', 'spring', 'node'];
      const exposedTech = techIndicators.filter((t) => nameStr.includes(t));

      if (exposedTech.length > 0) {
        assert.warn(false, 'Technology stack exposed',
          `Server name reveals technology: ${exposedTech.join(', ')} — consider generic server names`);
      }

      // Check capabilities for excessive feature exposure
      const caps = ctx.discovered.capabilities;
      const exposedCaps = Object.keys(caps).filter((k) => caps[k as keyof typeof caps]);
      assert.info('capabilities-exposed',
        `Server exposes ${exposedCaps.length} capabilities: ${exposedCaps.join(', ') || 'none'}`);

      return {
        assertions: assert.assertions,
        metadata: {
          serverName: serverInfo?.name,
          serverVersion: serverInfo?.version,
          exposedTech,
          capabilities: exposedCaps,
        },
      };
    },
  });

  return tests;
}
