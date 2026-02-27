require('dotenv').config();

const required = [
  'V1_HOST', 'V1_USER', 'V1_PASSWORD',
  'V2_HOST', 'V2_USER', 'V2_PASSWORD',
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error('ERROR: Variables de entorno obligatorias faltantes:');
  missing.forEach(key => console.error(`  - ${key}`));
  console.error('\nCopia .env.example a .env y completa las credenciales.');
  process.exit(1);
}

module.exports = {
  v1: {
    host: process.env.V1_HOST,
    port: parseInt(process.env.V1_PORT || '5432'),
    database: process.env.V1_DATABASE || 'postgres',
    schema: process.env.V1_SCHEMA || 'toniclife',
    user: process.env.V1_USER,
    password: process.env.V1_PASSWORD,
  },
  v2: {
    host: process.env.V2_HOST,
    port: parseInt(process.env.V2_PORT || '5432'),
    database: process.env.V2_DATABASE || 'toniclife_db_v2',
    schema: process.env.V2_SCHEMA || 'tonic',
    user: process.env.V2_USER,
    password: process.env.V2_PASSWORD,
  },
  migration: {
    batchSize: parseInt(process.env.BATCH_SIZE || '5000'),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
  gcs: {
    enabled: process.env.GCS_ENABLED === 'true',
    projectId: process.env.GCS_PROJECT_ID,
    bucketName: process.env.GCS_BUCKET_NAME,
    credentials: process.env.GCS_CREDENTIALS,
    concurrency: parseInt(process.env.GCS_CONCURRENCY || '8'),
    retryAttempts: parseInt(process.env.GCS_RETRY_ATTEMPTS || '3'),
    sourceBaseUrl: 'https://tonic-life.net',
  },
};
