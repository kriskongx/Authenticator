import "mocha";
import { expect } from "chai";
import { StorageLocation, UserSettings } from "../../models/settings";

mocha.setup("bdd");

describe("UserSettings.removeItem", () => {
  afterEach(async () => {
    await chrome.storage.local.remove("UserSettings");
    await chrome.storage.sync.remove("UserSettings");
    UserSettings.items = {};
  });

  it("preserves syncable and other local settings when removing a local key in sync mode", async () => {
    await chrome.storage.local.set({
      UserSettings: {
        storageLocation: StorageLocation.Sync,
        driveToken: "token-1",
        driveRevoked: true,
      },
    });
    await chrome.storage.sync.set({
      UserSettings: {
        theme: "dark",
        autolock: 15,
      },
    });

    await UserSettings.removeItem("driveRevoked");

    const localStored = (await chrome.storage.local.get("UserSettings"))
      .UserSettings;
    const syncStored = (await chrome.storage.sync.get("UserSettings"))
      .UserSettings;

    expect(localStored).to.deep.equal({
      storageLocation: StorageLocation.Sync,
      driveToken: "token-1",
    });
    expect(syncStored).to.deep.equal({
      theme: "dark",
      autolock: 15,
    });
    expect(UserSettings.items.theme).to.equal("dark");
    expect(UserSettings.items.driveToken).to.equal("token-1");
    expect(UserSettings.items.driveRevoked).to.equal(undefined);
  });
});
