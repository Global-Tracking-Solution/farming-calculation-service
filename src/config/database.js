// MySQL connection (GPS history for deviceId requests).
// Set DB_CONNECTION_STRING in .env, same format as the .NET apps:
//   DB_CONNECTION_STRING=Server=1.2.3.4;Database=db_global_tracking;User ID=user;Password=secret;Port=3306;SslMode=None;pooling=false;
// (or DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD). Without either, deviceId requests answer 503.
import mysql from 'mysql2/promise';

const parseConnectionString = text => Object.fromEntries(
  String(text).split(';').map(part => part.split('=')).filter(([key, ...rest]) => key.trim() && rest.length)
    .map(([key, ...rest]) => [key.trim().toLowerCase().replace(/\s+/g, ''), rest.join('=').trim()]));

export const loadDatabaseConfig = env => {
  const cs = env.DB_CONNECTION_STRING ? parseConnectionString(env.DB_CONNECTION_STRING) : {};
  const host = env.DB_HOST || cs.server || cs.host || cs.datasource;
  if (!host) return null;
  const ssl = String(cs.sslmode || '').toLowerCase();
  return {
    host,
    port: Number(env.DB_PORT || cs.port) || 3306,
    database: env.DB_NAME || cs.database || 'db_global_tracking',
    user: env.DB_USER || cs.userid || cs.uid || cs.user,
    password: env.DB_PASSWORD ?? cs.password ?? cs.pwd ?? '',
    ssl: ssl && ssl !== 'none' && ssl !== 'disabled' ? {rejectUnauthorized: false} : undefined,
  };
};

// A new connection for every call, closed afterwards (no pooling).
export const withConnection = async (dbConfig, work) => {
  const connection = await mysql.createConnection({
    ...dbConfig,
    connectTimeout: 15000,
    dateStrings: true,          // keep DATETIME values exactly as MySQL returns them ('YYYY-MM-DD HH:mm:ss')
  });
  try {
    return await work(connection);
  } finally {
    await connection.end().catch(() => connection.destroy());
  }
};
