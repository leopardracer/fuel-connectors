import {
  Address,
  type Asset,
  type AssetFuel,
  type ConnectorMetadata,
  type FuelABI,
  FuelConnector,
  FuelConnectorEventType,
  FuelConnectorEventTypes,
  type FuelConnectorSendTxParams,
  type HashableMessage,
  type Network,
  Provider,
  type SelectNetworkArguments,
  type TransactionRequest,
  type TransactionRequestLike,
  type TransactionResponse,
  type Version,
  deserializeTransactionResponseJson,
  transactionRequestify,
} from 'fuels';
import type { JSONRPCRequest } from 'json-rpc-2.0';
import { JSONRPCClient } from 'json-rpc-2.0';

import {
  APP_IMAGE,
  CONNECTOR_SCRIPT,
  CONTENT_SCRIPT_NAME,
  EVENT_MESSAGE,
} from './constants';
import {
  type CommunicationMessage,
  type EventMessage,
  MessageTypes,
  type ResponseMessage,
} from './types';

export class FuelWalletConnector extends FuelConnector {
  name = '';
  connected = false;
  installed = false;
  external = false;
  events = FuelConnectorEventTypes;
  metadata: ConnectorMetadata = {
    image: APP_IMAGE,
    install: {
      action: 'Install',
      description:
        'To connect your Fuel Wallet, install the browser extension.',
      link: 'https://chrome.google.com/webstore/detail/fuel-wallet/dldjpboieedgcmpkchcjcbijingjcgok',
    },
  };

  readonly client: JSONRPCClient;

  constructor(name = 'Fuel Wallet') {
    super();
    this.name = name;
    this.setMaxListeners(100);
    this.client = new JSONRPCClient(
      this.sendRequest.bind(this),
      this.createRequestId,
    );
    this.setupListener();
    this.setupConnector();
  }

  /**
   * ============================================================
   * Application communication methods
   * ============================================================
   */
  private async setupConnector() {
    if (typeof window !== 'undefined') {
      this.ping()
        .then(() => {
          window.dispatchEvent(
            new CustomEvent(FuelConnectorEventType, { detail: this }),
          );
        })
        .catch(() => {});
    }
  }

  private acceptMessage(message: MessageEvent<CommunicationMessage>): boolean {
    const { data: event } = message;
    return (
      message.origin === window.origin &&
      event.type !== MessageTypes.request &&
      event.connectorName === this.name &&
      event.target === CONNECTOR_SCRIPT
    );
  }

  private setupListener() {
    if (typeof window === 'undefined') return;
    window.addEventListener(EVENT_MESSAGE, this.onMessage.bind(this));
  }

  private createRequestId(): string {
    return crypto.randomUUID();
  }

  private postMessage(message: CommunicationMessage, origin?: string) {
    window.postMessage(message, origin || window.origin);
  }

  private async sendRequest(request: JSONRPCRequest | null) {
    if (!request) return;
    this.postMessage({
      type: MessageTypes.request,
      target: CONTENT_SCRIPT_NAME,
      connectorName: this.name,
      request,
    });
  }

  private onResponse(message: ResponseMessage): void {
    this.client.receive(message.response);
  }

  private onEvent(message: EventMessage): void {
    message.events.forEach((eventData) => {
      if (eventData.event === 'start') {
        this.setupConnector();
      } else {
        this.emit(eventData.event, ...eventData.params);
      }
    });
  }

  private onMessage = (message: MessageEvent<CommunicationMessage>) => {
    const messageFroze = Object.freeze(message);
    if (!this.acceptMessage(messageFroze)) return;
    const { data: event } = messageFroze;
    this.onCommunicationMessage(event);
  };

  private onCommunicationMessage = (message: CommunicationMessage) => {
    switch (message.type) {
      case MessageTypes.response:
        this.onResponse(message);
        break;
      case MessageTypes.event:
        this.onEvent(message);
        break;
      default:
    }
  };

  /**
   * ============================================================
   * Connector methods
   * ============================================================
   */
  private async prepareTransactionRequest(
    transaction: TransactionRequestLike,
    params?: FuelConnectorSendTxParams,
  ) {
    if (!transaction) {
      throw new Error('Transaction is required');
    }
    let txRequest = transactionRequestify(transaction);

    const {
      onBeforeSend,
      skipCustomFee,
      transactionState,
      transactionSummary,
    } = params || {};

    const providerToSend = params?.provider;

    if (onBeforeSend) {
      txRequest = await onBeforeSend(txRequest);
    }

    return {
      txRequest,
      providerToSend,
      skipCustomFee,
      transactionState,
      transactionSummary,
    };
  }

  async ping(): Promise<boolean> {
    return this.client.timeout(800).request('ping', {});
  }

  async isConnected(): Promise<boolean> {
    // If the wallet not exists or not connected, return false
    try {
      return await this.client.request('isConnected', {});
    } catch {
      return false;
    }
  }

  async connect(): Promise<boolean> {
    return this.client.request('connect', {});
  }

  async disconnect(): Promise<boolean> {
    return this.client.request('disconnect', {});
  }

  async accounts(): Promise<Array<string>> {
    const accounts = await this.client.request('accounts', {});
    return accounts;
  }

  async currentAccount(): Promise<string | null> {
    const account = await this.client.request('currentAccount', {});
    if (!account) return null;
    return Address.fromDynamicInput(account).toString();
  }

  async signMessage(
    address: string,
    message: HashableMessage,
  ): Promise<string> {
    if (typeof message === 'string' && !message.trim()) {
      throw new Error('Message is required');
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      !message.personalSign
    ) {
      throw new Error('Message is required');
    }

    return this.client.request('signMessage', {
      address,
      message,
    });
  }

  async sendTransaction(
    address: string,
    transaction: TransactionRequestLike,
    params?: FuelConnectorSendTxParams,
  ): Promise<string | TransactionResponse> {
    const {
      txRequest,
      providerToSend,
      skipCustomFee,
      transactionState,
      transactionSummary,
    } = await this.prepareTransactionRequest(transaction, params);

    const resp = await this.client.request('sendTransaction', {
      address,
      transaction: JSON.stringify(txRequest),
      provider: providerToSend,
      skipCustomFee,
      transactionState,
      transactionSummary,
      returnTransactionResponse: true,
    });

    if (typeof resp === 'object' && 'id' in resp && 'providerCache' in resp) {
      return deserializeTransactionResponseJson(resp);
    }

    return resp?.id || resp;
  }

  async signTransaction(
    address: string,
    transaction: TransactionRequestLike,
    params?: FuelConnectorSendTxParams,
  ): Promise<TransactionRequest> {
    const {
      txRequest,
      providerToSend,
      skipCustomFee,
      transactionState,
      transactionSummary,
    } = await this.prepareTransactionRequest(transaction, params);

    const txRequestSerialized: string = await this.client.request(
      'signTransaction',
      {
        address,
        transaction: JSON.stringify(txRequest),
        provider: providerToSend,
        skipCustomFee,
        transactionState,
        transactionSummary,
      },
    );

    const txRequestSigned = transactionRequestify(
      JSON.parse(txRequestSerialized),
    );

    return txRequestSigned;
  }

  async assets(): Promise<Array<Asset>> {
    return this.client.request('assets', {});
  }

  async addAsset(asset: Asset): Promise<boolean> {
    return this.addAssets([asset]);
  }

  async addAssets(assets: Asset[]): Promise<boolean> {
    /**
     * @todo: Remove this once Fuel Wallet supports assets with multiple networks
     */
    const assetsData = assets.map((asset) => {
      const fuelNetworkAsset = asset.networks.find(
        (n) => n.type === 'fuel',
      ) as AssetFuel;
      if (!fuelNetworkAsset) {
        throw new Error('Asset for Fuel Network not found!');
      }
      return {
        ...asset,
        imageUrl: asset.icon,
        decimals: fuelNetworkAsset.decimals,
        assetId: fuelNetworkAsset.assetId,
      };
    });
    return this.client.request('addAssets', {
      assets: assetsData,
    });
  }

  async addABI(contractId: string, abi: FuelABI): Promise<boolean> {
    return this.client.request('addAbi', {
      abiMap: {
        [contractId]: abi,
      },
    });
  }

  async getABI(contractId: string): Promise<FuelABI> {
    return this.client.request('getAbi', {
      contractId,
    });
  }

  async hasABI(contractId: string): Promise<boolean> {
    const abi = await this.getABI(contractId);
    return !!abi;
  }

  async currentNetwork(): Promise<Network> {
    return this.client.request('network', {});
  }

  async selectNetwork(network: SelectNetworkArguments): Promise<boolean> {
    return this.client.request('selectNetwork', {
      network,
    });
  }

  async networks(): Promise<Network[]> {
    return this.client.request('networks', {});
  }

  async addNetwork(networkUrl: string): Promise<boolean> {
    /**
     * @todo: Remove fetch provider once Fuel Wallet supports adding networks
     * by URL
     */
    const provider = new Provider(networkUrl);
    return this.client.request('addNetwork', {
      network: {
        url: provider.url,
        name: (await provider.getChain()).name,
      },
    });
  }

  async version(): Promise<Version> {
    return this.client.request('version', {
      app: '0.0.0',
      network: '0.0.0',
    });
  }
}
