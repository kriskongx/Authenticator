import "mocha";
import * as chai from "chai";
import * as sinon from "sinon";
import * as sinonChai from "sinon-chai";

import { mount, createLocalVue } from "@vue/test-utils";
import Vuex, { Store } from "vuex";
import CommonComponents from "../../../components/common/index";

import EnterPasswordPage from "../../../components/Popup/EnterPasswordPage.vue";
import { loadI18nMessages } from "../../../store/i18n";

const should = chai.should();
chai.use(sinonChai);
mocha.setup("bdd");
const localVue = createLocalVue();

describe("EnterPasswordPage", () => {
  before(async () => {
    localVue.prototype.i18n = await loadI18nMessages();
    localVue.use(Vuex);
    for (const component of CommonComponents) {
      localVue.component(component.name, component.component);
    }
  });

  let storeOpts = {
    modules: {
      accounts: {
        actions: {
          applyPassphrase: sinon.fake(),
        },
        mutations: {
          setWrongPassword: (
            state: { wrongPassword: boolean },
            value: boolean
          ) => {
            state.wrongPassword = value;
          },
        },
        state: { wrongPassword: false },
        namespaced: true,
      },
    },
  };
  let store: Store<typeof storeOpts>;

  beforeEach(() => {
    // Reset the reactive warning source before constructing each store.
    store = new Vuex.Store(storeOpts);
  });

  it("should apply password when button is clicked", async () => {
    const wrapper = mount(EnterPasswordPage, { store, localVue });

    const passwordInput = wrapper.find("input");
    const passwordButton = wrapper.find("button");

    passwordInput.setValue("somePassword");
    await passwordButton.trigger("click");
    storeOpts.modules.accounts.actions.applyPassphrase.should.have.been.calledWith(
      sinon.match.any,
      "somePassword"
    );
  });

  it("should apply password when enter is pressed", async () => {
    const wrapper = mount(EnterPasswordPage, { store, localVue });

    const passwordInput = wrapper.find("input");

    passwordInput.setValue("anotherPassword");
    await passwordInput.trigger("keyup.enter");
    storeOpts.modules.accounts.actions.applyPassphrase.should.have.been.calledWith(
      sinon.match.any,
      "anotherPassword"
    );
  });

  it("should autofocus password input", () => {
    const wrapper = mount(EnterPasswordPage, {
      store,
      localVue,
      attachToDocument: true,
    });

    const passwordInput = wrapper.find("input");

    passwordInput.element.should.eq(document.activeElement);
  });

  it("should not show incorrect password message", () => {
    const wrapper = mount(EnterPasswordPage, { store, localVue });

    const errorText = wrapper.find(".unlock-message");

    errorText.isVisible().should.be.false;
  });

  context("Incorrect password was entered", () => {
    it("should show incorrect password message", () => {
      storeOpts.modules.accounts.state.wrongPassword = true;
      store = new Vuex.Store(storeOpts);
      const wrapper = mount(EnterPasswordPage, { store, localVue });

      wrapper.text().should.contain(localVue.prototype.i18n.phrase_not_match);
    });
  });

  describe("inline device unlock", () => {
    const mountPage = () => mount(EnterPasswordPage, { store, localVue });

    it("does nothing when device unlock is not available", async () => {
      const wrapper = mountPage();
      const performUnlock = sinon.stub().resolves();
      wrapper.setMethods({ performUnlock });

      await wrapper.vm.unlockInline(true);

      performUnlock.should.not.have.been.called;
    });

    it("applies the bundle without opening a window on success", async () => {
      const wrapper = mountPage();
      const applyBundle = sinon.stub().resolves();
      const openWindow = sinon.stub();
      wrapper.setMethods({
        performUnlock: sinon.stub().resolves({
          version: 1,
          defaultKeyId: "default-key",
          keys: [{ id: "default-key", secret: "secret" }],
        }),
        applyBundle,
        openUnlockWindow: openWindow,
      });
      wrapper.vm.biometricEnabled = true;

      await wrapper.vm.unlockInline(true);

      applyBundle.should.have.been.calledOnce;
      openWindow.should.not.have.been.called;
    });

    it("falls back to the window when the prompt is refused", () => {
      const wrapper = mountPage();
      const openWindow = sinon.stub();
      wrapper.setMethods({ openUnlockWindow: openWindow });

      wrapper.vm.handleUnlockFailure(
        new DOMException("refused", "NotAllowedError"),
        true,
        100
      );

      openWindow.should.have.been.calledOnce;
    });

    it("reports a cancelled prompt without opening a window", () => {
      const wrapper = mountPage();
      const openWindow = sinon.stub();
      wrapper.setMethods({ openUnlockWindow: openWindow });

      wrapper.vm.handleUnlockFailure(
        new DOMException("cancelled", "NotAllowedError"),
        true,
        5000
      );

      openWindow.should.not.have.been.called;
      wrapper.vm.biometricError.should.equal(
        localVue.prototype.i18n.biometric_unlock_cancelled
      );
    });

    it("reports other failures", () => {
      const wrapper = mountPage();
      const openWindow = sinon.stub();
      wrapper.setMethods({ openUnlockWindow: openWindow });

      wrapper.vm.handleUnlockFailure(new Error("decrypt failed"), true, 5000);

      openWindow.should.not.have.been.called;
      wrapper.vm.biometricError.should.equal(
        localVue.prototype.i18n.biometric_unlock_failed
      );
    });

    it("stays silent when the automatic attempt fails", () => {
      const wrapper = mountPage();
      const openWindow = sinon.stub();
      wrapper.setMethods({ openUnlockWindow: openWindow });

      wrapper.vm.handleUnlockFailure(
        new DOMException("refused", "NotAllowedError"),
        false,
        100
      );

      openWindow.should.not.have.been.called;
      wrapper.vm.biometricError.should.equal("");
    });
  });
});
