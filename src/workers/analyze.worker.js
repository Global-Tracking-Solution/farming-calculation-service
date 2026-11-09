// Runs one analysis in its own thread so a big request can never freeze the web server.
import {parentPort, workerData} from 'worker_threads';
import {analyzeFarming} from '../services/farming/farmingEngine.js';

try {
  const {points, farmingPercent, date, mode} = workerData;
  parentPort.postMessage({ok: true, result: analyzeFarming(points, farmingPercent, date, mode)});
} catch (error) {
  parentPort.postMessage({ok: false, message: error?.message || 'analysis failed'});
}
