# Entangle Test Suite

Comprehensive test suite for the Entangle secure blind relay system.

## Test Categories

### Unit Tests

- **`packages/crypto/src/index.test.ts`** - Cryptographic primitives
  - Key derivation (Argon2id + HKDF)
  - AEAD encryption/decryption (XChaCha20-Poly1305)
  - HMAC computation and verification
  - Base64URL encoding/decoding
  - Capability ID generation
  - Policy hashing

- **`packages/protocol/src/frame.test.ts`** - Wire protocol
  - Frame encoding/decoding
  - Frame reader for streaming
  - Fragmented message handling
  - Multiple frame batching

- **`packages/utils/src/validation.test.ts`** - Input validation
  - Argument validation (count, length, NUL bytes, surrogates)
  - CWD path validation against allow-lists
  - Resource limit validation

- **`packages/utils/src/counters.test.ts`** - Counter logic
  - Monotonic counter validation
  - Bidirectional counter isolation
  - Replay attack prevention

### Integration Tests

- **`tests/agent/runner.test.ts`** - Agent process execution
  - Command spawning with fake tool
  - Resource limits (CPU, memory, wall time)
  - Output capture and limits
  - Process termination and signals
  - Environment isolation
  - Argument passing

- **`tests/server/routing.test.ts`** - Server routing logic
  - Agent registration and namespace assignment
  - Capability announcement and lookup
  - Invoker registration
  - Heartbeat tracking
  - Cleanup and disconnection handling

### End-to-End Tests

- **`tests/e2e/full-flow.test.ts`** - Complete system flow
  - Server startup on ephemeral port
  - Agent registration and capability creation
  - Invoker connection and command execution
  - Disconnection and reconnection scenarios
  - Health check endpoints

### Security Tests

- **`tests/security/replay-attacks.test.ts`** - Replay attack prevention
  - Monotonic counter enforcement
  - AEAD replay protection
  - HMAC replay protection
  - Session isolation
  - Time-based attack scenarios
  - Man-in-the-middle simulations

- **`tests/security/validation.test.ts`** - Security validation
  - Argument injection prevention
  - Path traversal prevention
  - Resource limit validation
  - AEAD tampering detection
  - HMAC validation attacks
  - Tool path validation
  - Crypto key isolation
  - Server blindness validation
  - Session state attacks

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run in watch mode
npm run test:watch

# Run specific test file
npx vitest packages/crypto/src/index.test.ts

# Run tests by pattern
npx vitest --run security

# Run E2E tests only
npx vitest tests/e2e/
```

## Test Infrastructure

- **Framework**: Vitest for fast execution and TypeScript support
- **Coverage**: V8 coverage with text, JSON, and HTML reports
- **Fake Tool**: Custom Node.js script for testing agent execution
- **Mocks**: WebSocket mocks for server testing
- **Setup**: Global test configuration in `test-setup.ts`

## Security Test Scenarios

The security tests validate the threat model from the specification:

1. **Replay Attacks**: Ensure monotonic counters prevent message replay
2. **Tampering**: Verify AEAD detects any modification of ciphertext
3. **Injection**: Validate argument and path sanitization
4. **Isolation**: Confirm sessions and capabilities are isolated
5. **Blindness**: Ensure server never sees plaintext data
6. **State Confusion**: Prevent unauthorized state transitions

## Coverage Goals

- **Crypto Package**: 100% coverage of all cryptographic operations
- **Protocol Package**: 100% coverage of frame handling
- **Utils Package**: 100% coverage of validation logic
- **Integration**: Cover all major execution paths
- **Security**: Cover all attack vectors from threat model

## Adding New Tests

1. Place unit tests alongside source files (`.test.ts`)
2. Place integration tests in `tests/` directory by component
3. Add security tests to `tests/security/` directory
4. Use descriptive test names that explain the scenario
5. Include both positive and negative test cases
6. Mock external dependencies appropriately