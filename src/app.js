import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import {createRunner} from './services/jobRunner.js';
import {createDeviceDataSource} from './services/deviceData.service.js';
import {requestLogger} from './middlewares/requestLogger.js';
import {notFound, createErrorHandler} from './middlewares/errorHandler.js';
import {createRoutes} from './routes/index.js';

export const createApp = (config, {runner, deviceData} = {}) => {
  const jobRunner = runner || createRunner({
    maxConcurrent: config.maxConcurrent,
    maxQueue: config.maxQueue,
    timeoutMs: config.jobTimeoutMs,
  });
  const deviceSource = deviceData !== undefined ? deviceData : config.db ? createDeviceDataSource(config.db) : null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({contentSecurityPolicy: false, crossOriginResourcePolicy: {policy: 'cross-origin'}}));
  app.use(compression());

  if (config.corsOrigins.length) {
    app.use(cors({origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization']}));
  } else if (!config.isProd) {
    app.use(cors());
  }

  app.use(requestLogger);
  app.use(express.json({limit: `${config.maxBodyMb}mb`}));

  app.use(createRoutes({config, runner: jobRunner, deviceData: deviceSource}));

  app.use(notFound);
  app.use(createErrorHandler(config));

  return app;
};
