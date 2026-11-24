<template>
  <span class="password-input" :class="{ 'has-biometric': biometric }">
    <input
      ref="input"
      v-bind="$attrs"
      v-on="inputListeners"
      :class="inputClass"
      :type="revealed ? 'text' : 'password'"
      :value="value"
      @input="$emit('input', $event.target.value)"
    />
    <span class="password-input-actions">
      <button
        v-if="biometric"
        type="button"
        class="password-input-toggle password-input-biometric"
        :disabled="biometricDisabled"
        :title="biometricLabel"
        :aria-label="biometricLabel"
        @click="$emit('biometric')"
      >
        <IconKey />
      </button>
      <button
        type="button"
        class="password-input-toggle"
        :title="toggleLabel"
        :aria-label="toggleLabel"
        :aria-pressed="revealed ? 'true' : 'false'"
        @click="toggle"
      >
        <IconEyeOff v-if="revealed" />
        <IconEye v-else />
      </button>
    </span>
  </span>
</template>
<script lang="ts">
import Vue from "vue";
import IconEye from "../../../svg/eye.svg";
import IconEyeOff from "../../../svg/eye-off.svg";
import IconKey from "../../../svg/key.svg";

export default Vue.extend({
  // Vue 2 always puts `class` on the component root, even with
  // inheritAttrs: false, so the input styling has to come in as a prop.
  inheritAttrs: false,
  components: { IconEye, IconEyeOff, IconKey },
  props: {
    value: { type: String, default: "" },
    inputClass: { type: String, default: "" },
    biometric: { type: Boolean, default: false },
    biometricDisabled: { type: Boolean, default: false },
    biometricTitle: { type: String, default: "" },
  },
  data() {
    return {
      revealed: false,
    };
  },
  computed: {
    inputListeners(): Vue["$listeners"] {
      const listeners = { ...this.$listeners };
      delete listeners.input;
      delete listeners.biometric;
      return listeners;
    },
    toggleLabel(): string {
      return this.revealed
        ? this.i18n.ui_hide_password
        : this.i18n.ui_show_password;
    },
    biometricLabel(): string {
      return this.biometricTitle || this.i18n.biometric_unlock_button;
    },
  },
  methods: {
    toggle() {
      const input = this.$refs.input as HTMLInputElement;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      this.revealed = !this.revealed;
      this.$nextTick(() => {
        // Keep the caret where it was instead of dropping focus.
        input.focus();
        if (start !== null && end !== null) {
          input.setSelectionRange(start, end);
        }
      });
    },
    focus() {
      const input = this.$refs.input as HTMLInputElement | undefined;
      input?.focus();
    },
  },
});
</script>
