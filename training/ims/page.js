import { completeAuthRedirect, getSession, isConfigured, signOut } from "../auth.js";
import { mountIms } from "./ims.js";

const gateTitle = document.getElementById("gate-title");
const gateMessage = document.getElementById("gate-message");

document.getElementById("sign-out").addEventListener("click", async () => { await signOut(); window.location.href = "../"; });

async function init() {
  const redirect = completeAuthRedirect();
  if (!isConfigured()) {
    gateTitle.textContent = "Secure service connection pending";
    gateMessage.textContent = "Document control is not connected yet.";
    return;
  }
  if (redirect.error) {
    gateTitle.textContent = "Sign-in link could not be verified";
    gateMessage.textContent = redirect.error;
    return;
  }
  if (!await getSession()) {
    gateTitle.textContent = "Sign-in required";
    gateMessage.innerHTML = 'Sign in through the <a href="../">training portal</a> with your work email, then return here.';
    return;
  }
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  await mountIms(document.getElementById("ims-root")).open();
}

init();
