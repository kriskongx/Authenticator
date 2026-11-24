<template>
  <div>
    <label>{{ label }}</label>
    <span
      class="password-input"
      :class="{ 'has-biometric': biometric }"
      v-if="isPassword"
    >
      <input
        :type="revealed ? 'text' : 'password'"
        class="input"
        :value="value"
        @input="$emit('input', $event.target.value)"
        @keyup.enter="$emit('enter')"
        ref="textInput"
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
    <input
      v-else
      :type="type ? type : 'text'"
      class="input"
      :value="value"
      @input="$emit('input', $event.target.value)"
      @keyup.enter="$emit('enter')"
      ref="textInput"
    />
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconEye from "../../../svg/eye.svg";
import IconEyeOff from "../../../svg/eye-off.svg";
import IconKey from "../../../svg/key.svg";

export default Vue.extend({
  components: { IconEye, IconEyeOff, IconKey },
  props: [
    "label",
    "value",
    "type",
    "autofocus",
    "biometric",
    "biometricDisabled",
    "biometricTitle",
  ],
  data() {
    return {
      revealed: false,
    };
  },
  computed: {
    isPassword(): boolean {
      return this.$props.type === "password";
    },
    toggleLabel(): string {
      return this.revealed
        ? this.i18n.ui_hide_password
        : this.i18n.ui_show_password;
    },
    biometricLabel(): string {
      return this.$props.biometricTitle || this.i18n.biometric_unlock_button;
    },
  },
  mounted() {
    if (!this.$props.autofocus) {
      return;
    }
    const textInput = this.$refs.textInput;
    if (textInput instanceof HTMLInputElement) {
      textInput.focus();
    }
  },
  methods: {
    toggle() {
      const input = this.$refs.textInput as HTMLInputElement;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      this.revealed = !this.revealed;
      this.$nextTick(() => {
        input.focus();
        if (start !== null && end !== null) {
          input.setSelectionRange(start, end);
        }
      });
    },
  },
});
</script>
