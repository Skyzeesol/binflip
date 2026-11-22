/**
 * All signing goes through this interface; nothing else in the codebase
 * touches key material. Implementations are swapped per stage (HANDOFF §12):
 *   stage 1–2: DryRunSigner (never signs)
 *   stage 3:   encrypted local keystore, one agent wallet per user
 *   public:    KMS/MPC or the non-custodial position-operator model
 */
export interface Signer {
  /** Agent wallet public key (base58). */
  readonly publicKey: string;
  /** Sign a serialized transaction message. Must throw if signing is not allowed. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export class SigningDisabledError extends Error {
  override name = "SigningDisabledError";
}

/** Signer used in dry-run mode. It refuses every signature request. */
export class DryRunSigner implements Signer {
  constructor(readonly publicKey: string) {}

  async signMessage(): Promise<Uint8Array> {
    throw new SigningDisabledError("Dry-run mode: signing is disabled.");
  }
}
