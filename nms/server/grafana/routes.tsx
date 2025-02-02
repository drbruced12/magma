/**
 * Copyright 2020 The Magma Authors.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Client from '../../grafana/GrafanaAPI';
import GrafanaErrorMessage from '../../grafana/GrafanaErrorMessage';
import React from 'react';
import ReactDOM from 'react-dom/server';
import asyncHandler from '../util/asyncHandler';
import proxy from 'express-http-proxy';
import {NextFunction, Request, Response, Router} from 'express';
import {
  makeGrafanaUsername,
  syncDashboards,
  syncDatasource,
  syncGrafanaUser,
  syncTenants,
} from '../../grafana/handlers';
import type {GrafanaClient} from '../../grafana/GrafanaAPI';
import type {Task} from '../../grafana/handlers';

const GRAFANA_PROTOCOL = 'http';
const GRAFANA_ADDRESS = process.env.USER_GRAFANA_ADDRESS ?? 'user-grafana:3000';
const GRAFANA_URL = `${GRAFANA_PROTOCOL}://${GRAFANA_ADDRESS}`;

const AUTH_PROXY_HEADER = 'X-WEBAUTH-USER';

const router = Router();

const grafanaAdminClient = Client(GRAFANA_URL, {
  [AUTH_PROXY_HEADER]: 'admin',
});

async function syncGrafana(req: Request, res: Response, next: NextFunction) {
  const [tenantsRes, grafanaSyncRes] = await Promise.all([
    syncTenants(),
    syncGrafanaMeta(grafanaAdminClient, req),
  ]);

  const completedTasks = [
    ...tenantsRes.completedTasks,
    ...grafanaSyncRes.completedTasks,
  ];

  if (tenantsRes.errorTask) {
    await displayErrorMessage(res, completedTasks, tenantsRes.errorTask);
  }
  if (grafanaSyncRes.errorTask) {
    await displayErrorMessage(res, completedTasks, grafanaSyncRes.errorTask);
  }
  return next();
}

async function syncGrafanaMeta(
  grafanaClient: GrafanaClient,
  req: Request,
): Promise<{completedTasks: Array<Task>; errorTask?: Task}> {
  const completedTasks = [];

  // Sync User/Organization
  const userRes = await syncGrafanaUser(grafanaClient, req);
  completedTasks.push(...userRes.completedTasks);
  if (userRes.errorTask) {
    return {completedTasks, errorTask: userRes.errorTask};
  }

  // Sync Datasource
  const dsRes = await syncDatasource(grafanaClient, req);
  completedTasks.push(...dsRes.completedTasks);
  if (dsRes.errorTask) {
    return {completedTasks, errorTask: dsRes.errorTask};
  }

  // Create Dashboards
  const dbRes = await syncDashboards(grafanaClient, req);
  completedTasks.push(...dbRes.completedTasks);
  if (dbRes.errorTask) {
    return {completedTasks, errorTask: dbRes.errorTask};
  }
  return {completedTasks};
}

async function displayErrorMessage(
  res: Response,
  completedTasks: Array<Task>,
  errorTask: Task,
) {
  const healthResponse = await grafanaAdminClient.getHealth();
  const message = (
    <GrafanaErrorMessage
      completedTasks={completedTasks}
      errorTask={errorTask}
      grafanaHealth={healthResponse.data}
    />
  );
  res.status(errorTask.status).send(ReactDOM.renderToString(message)).end();
}

const proxyMiddleware = () => {
  return function (req: Request, res: Response, next: NextFunction) {
    const userID = req.user.id;

    return proxy(GRAFANA_URL, {
      proxyReqOptDecorator: function (proxyReqOpts) {
        proxyReqOpts.headers![AUTH_PROXY_HEADER] = makeGrafanaUsername(userID);
        return proxyReqOpts;
      },
      proxyReqPathResolver: req => req.originalUrl.replace(/^\/grafana/, ''),
      userResDecorator: (proxyRes, proxyResData: Buffer, userReq, userRes) => {
        userRes.set('X-Frame-Options', 'allow');
        return proxyResData;
      },
    })(req, res, next);
  };
};

// Only the root path should perform the sync operations
router.all('/', asyncHandler(syncGrafana));
// Use proxy on all paths
router.use('/', proxyMiddleware());

export default router;
