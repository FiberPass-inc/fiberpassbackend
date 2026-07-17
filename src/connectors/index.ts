import { bitcoinPsbtConnector } from './bitcoinPsbtConnector.js';
import { btcpayConnector } from './btcpayConnector.js';
import { fiberConnector } from './fiberConnector.js';
import { nwcConnector } from './nwcConnector.js';
import { PaymentConnectorRegistry } from './registry.js';

export const paymentConnectorRegistry = new PaymentConnectorRegistry();
paymentConnectorRegistry.register(fiberConnector);
paymentConnectorRegistry.register(nwcConnector);
paymentConnectorRegistry.register(btcpayConnector);
paymentConnectorRegistry.register(bitcoinPsbtConnector);

export { bitcoinPsbtConnector, btcpayConnector, fiberConnector, nwcConnector };
