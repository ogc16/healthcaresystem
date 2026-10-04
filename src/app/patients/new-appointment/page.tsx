import Image from "next/image";
import { redirect } from "next/navigation";

import { AppointmentForm } from "@/components/forms/AppointmentForm";
import { PatientLogoutButton } from "@/components/PatientLogoutButton";
import { getPatient } from "@/lib/actions/patient.actions";
import { requirePatient } from "@/lib/auth/guards";

const Appointment = async () => {
  const { userId } = await requirePatient();
  const patient = await getPatient();

  if (!patient) redirect("/patients/register");

  return (
    <div className="flex h-screen max-h-screen">
      <section className="remove-scrollbar container my-auto">
        <div className="sub-container max-w-[860px] flex-1 justify-between">
          <Image
            src="/assets/icons/logo-full.svg"
            height={1000}
            width={1000}
            alt="logo"
            className="mb-12 h-10 w-fit"
          />

          <div className="flex items-center justify-between gap-4">
            <AppointmentForm
              patientId={patient?.$id}
              userId={userId}
              type="create"
            />

            <PatientLogoutButton />
          </div>

          <p className="copyright mt-10 py-12">© 2026 CarePulse</p>
        </div>
      </section>

      <Image
        src="/assets/images/appointment-img.png"
        height={1500}
        width={1500}
        alt="appointment"
        className="side-img max-w-[390px] bg-bottom"
      />
    </div>
  );
};

export default Appointment;
