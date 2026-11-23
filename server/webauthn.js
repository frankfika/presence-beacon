'use strict';
/**
 * 在岗哨 · WebAuthn 封装
 *
 * 用 @simplewebauthn/server 做标准校验（内部处理 COSE / CBOR / 签名验证）。
 * 浏览器端不依赖任何库，直接用 navigator.credentials。
 */
const crypto = require('node:crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

class WebAuthnService {
  constructor(store, { rpName = '在岗哨', rpID = 'localhost', origins = [] } = {}) {
    this.store = store;
    this.rpName = rpName;
    this.rpID = rpID;
    this.origins = origins;
  }

  /* ── 注册 ── */
  async registrationOptions({ employee, deviceToken }) {
    const existing = this.store.listCredentials(employee.id);
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: fromB64url(b64url(Buffer.from(employee.id))),
      userName: employee.id,
      userDisplayName: employee.name,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    const challengeId = crypto.randomUUID();
    this.store.putChallenge({ id: challengeId, challenge: options.challenge, kind: 'register', employeeId: employee.id });
    return { challengeId, options };
  }

  async verifyRegistration({ employee, response, challengeId, origin }) {
    const ch = this.store.takeChallenge(challengeId);
    if (!ch || ch.kind !== 'register' || ch.employee_id !== employee.id) {
      throw new Error('注册挑战无效或已过期');
    }
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('生物特征注册验证失败');
    }
    const info = verification.registrationInfo;
    const credId = typeof info.credential.id === 'string' ? info.credential.id : b64url(info.credential.id);
    const pubKey = info.credential.publicKey instanceof Uint8Array
      ? b64url(info.credential.publicKey)
      : b64url(Buffer.from(info.credential.publicKey));
    this.store.addCredential({
      id: credId,
      employeeId: employee.id,
      publicKey: pubKey,
      counter: info.credential.counter ?? 0,
      transports: info.credential.transports ?? null,
    });
    return { credentialId: credId };
  }

  /* ── 认证（每次打卡都做一次） ── */
  async authenticationOptions({ employee, sessionId = null }) {
    const creds = this.store.listCredentials(employee.id);
    if (!creds.length) throw new Error('该员工尚未登记生物特征');
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: c.id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
    });
    const challengeId = crypto.randomUUID();
    this.store.putChallenge({
      id: challengeId, challenge: options.challenge, kind: 'assert',
      employeeId: employee.id, sessionId,
    });
    return { challengeId, options };
  }

  async verifyAuthentication({ employee, response, challengeId, origin }) {
    const ch = this.store.takeChallenge(challengeId);
    if (!ch || ch.kind !== 'assert' || ch.employee_id !== employee.id) {
      throw new Error('认证挑战无效或已过期');
    }
    const credId = typeof response.id === 'string' ? response.id : b64url(response.id);
    const cred = this.store.getCredential(credId);
    if (!cred || cred.employee_id !== employee.id) throw new Error('凭据不匹配');

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: this.rpID,
      credential: {
        id: cred.id,
        publicKey: fromB64url(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('生物特征验证失败');
    if (typeof verification.authenticationInfo?.newCounter === 'number') {
      this.store.bumpCounter(cred.id, verification.authenticationInfo.newCounter);
    }
    return { credentialId: cred.id, challengeId };
  }
}

module.exports = { WebAuthnService, b64url, fromB64url };
