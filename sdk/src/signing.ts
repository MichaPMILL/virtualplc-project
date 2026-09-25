// Signed programs: the engineer signs the program image with an Ed25519 key; CPUs started
// with --signed-programs load only images signed by a key they trust (IEC 62443-3-3 SR 3.4).
// Signature sent with DOWNLOAD_END: public key (32 bytes) + signature (64 bytes) of
// "VirtualPLC program|" + sha256 hex of the image.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

export function programSigningMessage(image: Uint8Array): Buffer {
  return Buffer.from(`VirtualPLC program|${createHash('sha256').update(image).digest('hex')}`, 'utf8');
}

/** New engineering key: private key (PEM, PKCS#8) and public key (hex) */
export function createEngineeringKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { privateKeyPem, publicKey: engineeringPublicKey(privateKeyPem) };
}

/** Public key (hex) of an engineering private key (PEM) */
export function engineeringPublicKey(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x ?? '', 'base64url').toString('hex');
}

/** Signature block of DOWNLOAD_END (96 bytes) */
export function signProgram(image: Uint8Array, privateKeyPem: string): Buffer {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, programSigningMessage(image), key);
  return Buffer.concat([Buffer.from(engineeringPublicKey(privateKeyPem), 'hex'), signature]);
}
