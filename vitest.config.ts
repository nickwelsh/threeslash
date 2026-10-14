import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        allowOnly: false,
        projects: [
            {
                test: {
                    name: 'unit',
                    expect: { requireAssertions: true },
                    environment: 'node',
                    include: ['test/*.test.ts'],
                },
            },
            {
                test: {
                    name: 'integration',
                    expect: { requireAssertions: true },
                    environment: 'node',
                    include: ['test/integration/*.test.ts'],
                    testTimeout: 15_000,
                },
            },
        ],
    },
});
