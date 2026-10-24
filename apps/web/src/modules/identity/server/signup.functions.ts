import { createServerFn } from "@tanstack/react-start";
import { serverInput } from "@/lib/validation";
import {
  otpVerifySchema,
  resendOtpSchema,
} from "@/modules/identity/contract/auth/schemas";
import { verifyOtpImpl, resendOtpImpl } from "./signup.server";

export const verifyOtp = createServerFn({ method: "POST" })
  .validator(serverInput(otpVerifySchema))
  .handler(async ({ data }) => {
    return verifyOtpImpl({ data });
  });

export const resendOtp = createServerFn({ method: "POST" })
  .validator(serverInput(resendOtpSchema))
  .handler(async ({ data }) => {
    return resendOtpImpl({ data });
  });
