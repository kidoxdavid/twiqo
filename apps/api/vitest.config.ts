import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://twiqo:twiqo@localhost:5432/twiqo_test',
      RATE_LIMIT_DISABLED: 'true',
      UPLOAD_DIR: '/tmp/twiqo-test-uploads',
      JWT_SECRET: 'test-secret-test-secret-test',
    },
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
