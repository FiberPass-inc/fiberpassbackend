import { fiberConnector } from './fiberConnector.js';
import { PaymentConnectorRegistry } from './registry.js';

export const paymentConnectorRegistry = new PaymentConnectorRegistry();
paymentConnectorRegistry.register(fiberConnector);

export { fiberConnector };
