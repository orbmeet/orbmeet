import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import { otpVerifySchema, resendOtpSchema } from "@/modules/identity/contract/auth/schemas";
import { verifyLoginOtpImpl, resendLoginOtpImpl, getSessionImpl, getRememberedUserImpl, logoutImpl } from "./login.server";

export const verifyLoginOtp = createServerFn({ method: "POST" })
  .validator(serverInput(otpVerifySchema))
  .handler(async ({ data }) => {
    return verifyLoginOtpImpl({ data });
  });

export const resendLoginOtp = createServerFn({ method: "POST" })
  .validator(serverInput(resendOtpSchema))
  .handler(async ({ data }) => {
    return resendLoginOtpImpl({ data });
  });

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  return getSessionImpl();
});

export const getRememberedUser = createServerFn({ method: "GET" }).handler(async () => {
  return getRememberedUserImpl();
});

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  return logoutImpl();
});
