import { fiberConnector } from './fiberConnector.js';
import { nwcConnector } from './nwcConnector.js';
import { PaymentConnectorRegistry } from './registry.js';

export const paymentConnectorRegistry = new PaymentConnectorRegistry();
paymentConnectorRegistry.register(fiberConnector);
paymentConnectorRegistry.register(nwcConnector);

export { fiberConnector, nwcConnector };
