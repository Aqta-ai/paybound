// SPDX-License-Identifier: Apache-2.0
// Server side of passkey approval. The browser returns the raw WebAuthn assertion parts;
// this module normalises the signature, finds the JSON indices the contract needs and
// ABI-encodes the WebAuthnAuth struct that PasskeyApprover.isValidSignature expects.
import { encodeAbiParameters, type Hex } from "viem";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type PasskeyAssertion = {
  authenticatorData: Hex; // hex of response.authenticatorData
  clientDataJSON: string; // UTF-8 text of response.clientDataJSON
  signature: Hex; // hex of response.signature (DER-encoded ECDSA P-256)
};

/** DER ECDSA signature to (r, s), with s in the lower half as OpenZeppelin's P256 requires. */
export function derToRs(der: Hex): { r: Hex; s: Hex } {
  const b = Buffer.from(der.slice(2), "hex");
  if (b[0] !== 0x30) throw new Error("signature is not DER");
  let i = 2;
  if (b[1] & 0x80) i = 2 + (b[1] & 0x7f);
  const readInt = () => {
    if (b[i] !== 0x02) throw new Error("bad DER integer");
    const len = b[i + 1];
    const v = b.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(`0x${Buffer.from(v).toString("hex") || "0"}`);
  };
  const r = readInt();
  let s = readInt();
  if (s > P256_N / 2n) s = P256_N - s;
  const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  return { r: hex32(r), s: hex32(s) };
}

/** abi.encode(WebAuthn.WebAuthnAuth) for PasskeyApprover. */
export function encodePasskeySignature(a: PasskeyAssertion): Hex {
  const { r, s } = derToRs(a.signature);
  const challengeIndex = a.clientDataJSON.indexOf('"challenge":"');
  const typeIndex = a.clientDataJSON.indexOf('"type":"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error("clientDataJSON is missing type or challenge");
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "challengeIndex", type: "uint256" },
          { name: "typeIndex", type: "uint256" },
          { name: "authenticatorData", type: "bytes" },
          { name: "clientDataJSON", type: "string" },
        ],
      },
    ],
    [{ r, s, challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON }],
  );
}

export const PASSKEY_APPROVER_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;
export const ERC1271_MAGIC = "0x1626ba7e";
