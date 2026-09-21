// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
import "reflect-metadata";
import {randomBytes, webcrypto} from "node:crypto";
import type {ServerOptions} from "node:https";
import {BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension,
  SubjectAlternativeNameExtension, X509CertificateGenerator} from "@peculiar/x509";

export const MODEL_PIPE_SERVER_NAME = "model-broker.invalid" as const;
const crypto = webcrypto as unknown as Crypto;
const algorithm = {name:"ECDSA",namedCurve:"P-256",hash:"SHA-256"};
const serial = () => `01${randomBytes(19).toString("hex")}`;

/** Fresh, memory-only trust per Worker lease. Never exports private material to the Worker. */
export async function createModelPipeTls(expiresAt:number):Promise<{certificatePem:string;options:ServerOptions}> {
  const now=Date.now();
  const authority=await crypto.subtle.generateKey(algorithm,true,["sign","verify"]) as CryptoKeyPair;
  const subject=`CN=Yuan Zhou Model Pipe ${randomBytes(16).toString("hex")}`;
  const ca=await X509CertificateGenerator.createSelfSigned({serialNumber:serial(),name:subject,
    notBefore:new Date(now-60_000),notAfter:new Date(expiresAt),keys:authority,signingAlgorithm:algorithm,
    extensions:[new BasicConstraintsExtension(true,0,true),new KeyUsagesExtension(KeyUsageFlags.keyCertSign,true)]},crypto);
  const server=await crypto.subtle.generateKey(algorithm,true,["sign","verify"]) as CryptoKeyPair;
  const certificate=await X509CertificateGenerator.create({serialNumber:serial(),subject:`CN=${MODEL_PIPE_SERVER_NAME}`,
    issuer:subject,notBefore:new Date(now-60_000),notAfter:new Date(expiresAt),publicKey:server.publicKey,
    signingKey:authority.privateKey,signingAlgorithm:algorithm,extensions:[
      new BasicConstraintsExtension(false,undefined,true),new KeyUsagesExtension(KeyUsageFlags.digitalSignature,true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"],true),
      new SubjectAlternativeNameExtension([{type:"dns",value:MODEL_PIPE_SERVER_NAME}]),
    ]},crypto);
  const der=Buffer.from(await crypto.subtle.exportKey("pkcs8",server.privateKey));
  try {
    return {certificatePem:ca.toString("pem"),options:{
      cert:certificate.toString("pem"),key:Buffer.from(`-----BEGIN PRIVATE KEY-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`),
      minVersion:"TLSv1.2",maxVersion:"TLSv1.3",ALPNProtocols:["http/1.1"],
      // Ticket keys are unique even if Node's process-wide defaults change.
      ticketKeys:randomBytes(48),sessionTimeout:60,handshakeTimeout:5000,
    }};
  } finally { der.fill(0); }
}
