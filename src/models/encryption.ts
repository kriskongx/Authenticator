import AES from "crypto-js/aes";
import Utf8 from "crypto-js/enc-utf8";

export class Encryption implements EncryptionInterface {
  private password: string;
  private keyId: string;

  constructor(hash: string, keyId: string) {
    this.password = hash;
    this.keyId = keyId;
  }

  getEncryptedString(data: string): string {
    if (!this.password) {
      return data;
    } else {
      return AES.encrypt(data, this.password).toString();
    }
  }

  decryptSecretString(secret: string) {
    if (!this.password) {
      return null;
    }
    try {
      const decryptedSecret = AES.decrypt(secret, this.password).toString(Utf8);

      if (!decryptedSecret) {
        return null;
      }

      if (decryptedSecret.length < 8) {
        return null;
      }

      if (
        !/^[a-z2-7]+=*$/i.test(decryptedSecret) &&
        !/^[0-9a-f]+$/i.test(decryptedSecret) &&
        !/^blz-/.test(decryptedSecret) &&
        !/^bliz-/.test(decryptedSecret) &&
        !/^stm-/.test(decryptedSecret)
      ) {
        return null;
      }

      return decryptedSecret;
    } catch (error) {
      return null;
    }
  }

  decryptEncSecret(entry: OTPEntryInterface) {
    if (!this.password) {
      return null;
    }
    try {
      if (!entry.encData) {
        return null;
      }

      const decryptedData = AES.decrypt(entry.encData, this.password).toString(
        Utf8
      );

      if (!decryptedData) {
        return null;
      }

      return JSON.parse(decryptedData);
    } catch (error) {
      return null;
    }
  }

  getEncryptionStatus(): boolean {
    return this.password ? true : false;
  }

  getEncryptionPassword(): string {
    return this.password;
  }
  updateEncryptionPassword(password: string) {
    this.password = password;
  }

  setEncryptionKeyId(id: string): void {
    this.keyId = id;
  }

  getEncryptionKeyId(): string {
    return this.keyId;
  }
}
