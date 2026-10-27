export function passwordValid(password: string): boolean {
  return password.length >= 8 && password.length <= 128 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export function passwordPair(password: string, confirmation: string) {
  return {
    valid: passwordValid(password) && password === confirmation,
    policyError: password.length > 0 && !passwordValid(password),
    mismatch: confirmation.length > 0 && password !== confirmation,
  };
}
