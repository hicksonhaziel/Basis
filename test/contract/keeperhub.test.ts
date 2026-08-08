/**
 * Contract tests for KeeperHub client.
 * These verify the client correctly handles all documented response shapes
 * without making real network calls. They use a mock HTTP server.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { KeeperHubClient } from '../../src/keeperhub/client.ts';
import {
  SimulationRevertError,
  InsufficientBalanceError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  RateLimitError,
} from '../../src/keeperhub/errors.ts';

let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('KeeperHub client contract tests', () => {
  beforeEach(async () => {
    baseUrl = await startServer();
  });

  afterEach(async () => {
    await stopServer();
  });

  describe('simulate', () => {
    it('returns SimulationSuccess on 200', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          status: 'simulated',
          from: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
          to: '0x4200000000000000000000000000000000000006',
          value: '0',
          gasEstimate: '65000',
          simulatedReturnValue: true,
          wouldRevert: false,
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const result = await client.simulate({
        contractAddress: '0x4200000000000000000000000000000000000006',
        chainId: 8453,
        functionName: 'deposit',
        abi: '[]',
      });

      assert.equal(result.success, true);
      assert.equal(result.gasEstimate, '65000');
      assert.equal(result.from, '0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
      assert.equal(result.wouldRevert, false);
    });

    it('throws SimulationRevertError on would-revert 400', async () => {
      handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          status: 'simulated',
          from: '0xABC',
          to: '0xDEF',
          value: '0',
          wouldRevert: true,
          revertReason: 'Error(ERC20: transfer amount exceeds balance)',
          error: 'Error(ERC20: transfer amount exceeds balance)',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      await assert.rejects(
        () => client.simulate({
          contractAddress: '0xDEF',
          chainId: 1,
          functionName: 'transfer',
        }),
        (err: unknown) => {
          assert.ok(err instanceof SimulationRevertError);
          assert.match(err.revertReason, /exceeds balance/);
          return true;
        },
      );
    });

    it('throws InsufficientBalanceError with details', async () => {
      handler = (_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          status: 'simulated',
          from: '0xABC',
          to: '0xDEF',
          value: '1000000000000000000',
          wouldRevert: true,
          revertReason: 'Insufficient ETH balance.',
          error: 'Insufficient ETH balance.',
          code: 'insufficient_balance',
          balanceWei: '250000000000000000',
          requiredWei: '1000000000000000000',
          shortfallWei: '750000000000000000',
          nativeSymbol: 'ETH',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      await assert.rejects(
        () => client.simulate({
          contractAddress: '0xDEF',
          chainId: 1,
          functionName: 'deposit',
          value: '1.0',
        }),
        (err: unknown) => {
          assert.ok(err instanceof InsufficientBalanceError);
          assert.equal(err.balanceWei, '250000000000000000');
          assert.equal(err.shortfallWei, '750000000000000000');
          return true;
        },
      );
    });
  });

  describe('executeContractCall', () => {
    it('returns execution response on 202', async () => {
      handler = (_req, res) => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          executionId: 'direct_456',
          status: 'completed',
          transactionHash: '0xabc123',
          transactionLink: 'https://basescan.org/tx/0xabc123',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const result = await client.executeContractCall(
        { contractAddress: '0x123', chainId: 8453, functionName: 'execute' },
        'idem-key-1',
      );

      assert.equal(result.executionId, 'direct_456');
      assert.equal(result.status, 'completed');
      assert.equal(result.transactionHash, '0xabc123');
    });

    it('recognizes idempotent replay', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          executionId: 'direct_456',
          status: 'completed',
          transactionHash: '0xabc123',
          idempotentReplay: true,
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const result = await client.executeContractCall(
        { contractAddress: '0x123', chainId: 8453, functionName: 'execute' },
        'idem-key-1',
      );

      assert.equal(result.idempotentReplay, true);
      assert.equal(result.executionId, 'direct_456');
    });

    it('throws IdempotencyConflictError on 409 conflict', async () => {
      handler = (_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'idempotency_conflict',
          originalExecutionId: 'direct_789',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      await assert.rejects(
        () => client.executeContractCall(
          { contractAddress: '0x123', chainId: 8453, functionName: 'execute' },
          'conflicting-key',
        ),
        (err: unknown) => {
          assert.ok(err instanceof IdempotencyConflictError);
          assert.equal(err.originalExecutionId, 'direct_789');
          return true;
        },
      );
    });

    it('throws IdempotencyInProgressError on 409 in_progress', async () => {
      handler = (_req, res) => {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'idempotency_in_progress' }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      await assert.rejects(
        () => client.executeContractCall(
          { contractAddress: '0x123', chainId: 8453, functionName: 'execute' },
          'in-progress-key',
        ),
        (err: unknown) => {
          assert.ok(err instanceof IdempotencyInProgressError);
          return true;
        },
      );
    });

    it('throws RateLimitError on 429', async () => {
      handler = (_req, res) => {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '30',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      await assert.rejects(
        () => client.executeContractCall(
          { contractAddress: '0x123', chainId: 8453, functionName: 'execute' },
          'rate-limited-key',
        ),
        (err: unknown) => {
          assert.ok(err instanceof RateLimitError);
          assert.equal(err.retryAfterSeconds, 30);
          return true;
        },
      );
    });
  });

  describe('getExecutionStatus', () => {
    it('returns status with poll interval hint', async () => {
      handler = (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Poll-Interval-Hint': '5',
        });
        res.end(JSON.stringify({
          executionId: 'direct_123',
          status: 'completed',
          type: 'contract-call',
          transactionHash: '0xfeed',
          sponsored: false,
          receipts: [{
            hash: '0xfeed',
            chainId: 11155111,
            verified: true,
            receiptStatus: 'success',
            blockNumber: 11413447,
            gasUsed: '68115',
            verifiedAt: '2024-01-01T00:00:15Z',
          }],
          gasUsedWei: '21000000000000',
          error: null,
          createdAt: '2024-01-01T00:00:00Z',
          completedAt: '2024-01-01T00:00:15Z',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const { status, pollIntervalHint } = await client.getExecutionStatus('direct_123');

      assert.equal(status.executionId, 'direct_123');
      assert.equal(status.status, 'completed');
      assert.equal(status.receipts.length, 1);
      assert.equal(status.receipts[0]!.verified, true);
      assert.equal(status.receipts[0]!.receiptStatus, 'success');
      assert.equal(status.receipts[0]!.gasUsed, '68115');
      assert.equal(status.sponsored, false);
      assert.equal(pollIntervalHint, 5);
    });

    it('handles terminal poll hint of 0', async () => {
      handler = (_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Poll-Interval-Hint': '0',
        });
        res.end(JSON.stringify({
          executionId: 'direct_123',
          status: 'failed',
          type: 'transfer',
          sponsored: false,
          receipts: [],
          error: 'Contract call failed',
          createdAt: '2024-01-01T00:00:00Z',
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const { status, pollIntervalHint } = await client.getExecutionStatus('direct_123');

      assert.equal(status.status, 'failed');
      assert.equal(status.error, 'Contract call failed');
      assert.equal(pollIntervalHint, 0);
    });
  });

  describe('pollUntilComplete', () => {
    it('polls until completed', async () => {
      let callCount = 0;
      handler = (_req, res) => {
        callCount++;
        const status = callCount < 3 ? 'running' : 'completed';
        const hint = callCount < 3 ? '1' : '0';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Poll-Interval-Hint': hint,
        });
        res.end(JSON.stringify({
          executionId: 'direct_poll',
          status,
          type: 'contract-call',
          sponsored: false,
          receipts: status === 'completed' ? [{
            hash: '0xdone',
            chainId: 8453,
            verified: true,
            receiptStatus: 'success',
            blockNumber: 100,
            gasUsed: '50000',
            verifiedAt: '2024-01-01T00:00:05Z',
          }] : [],
          createdAt: '2024-01-01T00:00:00Z',
          ...(status === 'completed' ? { completedAt: '2024-01-01T00:00:05Z' } : {}),
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const pollCounts: string[] = [];
      const result = await client.pollUntilComplete('direct_poll', {
        timeoutMs: 10_000,
        onPoll: (s) => pollCounts.push(s.status),
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.receipts[0]!.verified, true);
      assert.ok(callCount >= 3);
    });
  });

  describe('getOrgWalletAddress', () => {
    it('discovers wallet from simulation from field', async () => {
      handler = (req, res) => {
        // Parse request to verify it's a simulate call
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.equal(parsed.simulate, true);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            status: 'simulated',
            from: '0x1234567890abcdef1234567890abcdef12345678',
            to: '0x4200000000000000000000000000000000000006',
            value: '0',
            gasEstimate: '25000',
            simulatedReturnValue: '0',
            wouldRevert: false,
          }));
        });
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_test' });
      const wallet = await client.getOrgWalletAddress(8453);
      assert.equal(wallet, '0x1234567890abcdef1234567890abcdef12345678');
    });
  });

  describe('auth header', () => {
    it('sends bearer token in all requests', async () => {
      let authHeader = '';
      handler = (req, res) => {
        authHeader = req.headers['authorization'] ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          status: 'simulated',
          from: '0x00',
          to: '0x00',
          value: '0',
          gasEstimate: '1',
          simulatedReturnValue: null,
          wouldRevert: false,
        }));
      };

      const client = new KeeperHubClient({ baseUrl, apiKey: 'kh_my_secret_key' });
      await client.simulate({
        contractAddress: '0x00',
        chainId: 1,
        functionName: 'test',
      });

      assert.equal(authHeader, 'Bearer kh_my_secret_key');
    });
  });
});
