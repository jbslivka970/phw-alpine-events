import dotenv from 'dotenv';

dotenv.config();

interface ServerConfig {
  port: number;
  nodeEnv: string;
}

function loadServerConfig(): ServerConfig {
  return {
    port: parseInt(process.env['PORT'] ?? '3001', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
  };
}

export { loadServerConfig };
export type { ServerConfig };