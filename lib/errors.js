export class ConfigurationError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.message = message || 'Invalid configuration file given';
  }
}
