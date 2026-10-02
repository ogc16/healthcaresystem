"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Form } from "@/components/ui/form";
import { loginPatient } from "@/lib/actions/auth.actions";
import { LoginSchema } from "@/lib/validation";

import CustomFormField, { FormFieldType } from "../CustomFormField";
import SubmitButton from "../SubmitButton";

export const LoginForm = ({ returnTo }: { returnTo?: string }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState("");

  const form = useForm<z.infer<typeof LoginSchema>>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  const onSubmit = async (values: z.infer<typeof LoginSchema>) => {
    setIsLoading(true);
    setFormError("");

    try {
      const result = await loginPatient(values, returnTo);

      if (result?.error) setFormError(result.error);
    } catch (error) {
      console.error(error);
      setFormError("Unable to sign in right now. Please try again.");
    }

    setIsLoading(false);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 space-y-6">
        <section className="mb-12 space-y-4">
          <h1 className="header">Welcome back</h1>
          <p className="text-dark-700">Sign in to manage your appointments.</p>
        </section>

        <CustomFormField
          fieldType={FormFieldType.INPUT}
          control={form.control}
          name="email"
          label="Email"
          placeholder="johndoe@gmail.com"
          iconSrc="/assets/icons/email.svg"
          iconAlt="email"
        />

        <CustomFormField
          fieldType={FormFieldType.PASSWORD}
          control={form.control}
          name="password"
          label="Password"
          placeholder="••••••••"
        />

        {formError && <p className="shad-error text-14-regular">{formError}</p>}

        <SubmitButton isLoading={isLoading}>Sign in</SubmitButton>
      </form>
    </Form>
  );
};
