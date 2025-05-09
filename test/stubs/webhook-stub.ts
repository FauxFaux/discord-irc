export default function createWebhookStub(sendWebhookMessage) {
  return class WebhookStub {
    id;
    token;
    constructor(id, token) {
      this.id = id;
      this.token = token;
    }

    async send(...args) {
      sendWebhookMessage(...args);
      return new Promise(() => {});
    }

    destroy() {}
  };
}
