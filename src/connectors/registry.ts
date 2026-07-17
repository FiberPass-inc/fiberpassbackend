import { ApiError } from '../lib/errors.js';
import type { AssetId, PaymentRail } from '../domain/payment.js';
import type { ConnectorCapability, PaymentConnector } from './paymentConnector.js';

export interface ConnectorSelector {
  rail: PaymentRail;
  network: string;
  assetId: AssetId;
}

function capabilityKey(selector: ConnectorSelector): string {
  return [selector.rail, selector.network.trim().toLowerCase(), selector.assetId].join('|');
}

export class PaymentConnectorRegistry {
  private readonly connectors = new Map<string, PaymentConnector>();
  private readonly capabilityOwners = new Map<string, PaymentConnector>();

  register(connector: PaymentConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error('Payment connector id is already registered: ' + connector.id);
    }
    const capabilities = connector.capabilities();
    if (capabilities.length === 0) throw new Error('Payment connector must declare at least one capability.');
    const registrations: Array<{ key: string; connector: PaymentConnector }> = [];
    for (const capability of capabilities) {
      if (capability.connectorId !== connector.id) {
        throw new Error('Connector capability id does not match its connector.');
      }
      const key = capabilityKey(capability);
      if (this.capabilityOwners.has(key)) {
        throw new Error('Payment capability is already registered: ' + key);
      }
      if (registrations.some((registration) => registration.key === key)) {
        throw new Error('Payment connector declares a duplicate capability: ' + key);
      }
      registrations.push({ key, connector });
    }
    for (const registration of registrations) this.capabilityOwners.set(registration.key, registration.connector);
    this.connectors.set(connector.id, connector);
  }

  find(selector: ConnectorSelector): PaymentConnector | undefined {
    return this.capabilityOwners.get(capabilityKey(selector));
  }

  require(selector: ConnectorSelector): PaymentConnector {
    const connector = this.find(selector);
    if (!connector) {
      throw new ApiError(
        400,
        'PAYMENT_CAPABILITY_UNSUPPORTED',
        'No payment connector supports the requested rail, network, and asset.'
      );
    }
    return connector;
  }

  capabilities(): ConnectorCapability[] {
    return [...this.connectors.values()]
      .flatMap((connector) => connector.capabilities())
      .sort((left, right) => capabilityKey(left).localeCompare(capabilityKey(right)));
  }
}
