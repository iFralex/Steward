const header = document.querySelector("[data-header]");
const menuButton = document.querySelector("[data-menu-button]");
const mobileMenu = document.querySelector("[data-mobile-menu]");

const updateHeader = () => header?.classList.toggle("scrolled", window.scrollY > 18);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

menuButton?.addEventListener("click", () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  mobileMenu?.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
});

mobileMenu?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuButton?.setAttribute("aria-expanded", "false");
    mobileMenu.classList.remove("open");
    document.body.classList.remove("menu-open");
  });
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.09, rootMargin: "0px 0px -35px" },
);
document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

const planeDescriptions = {
  interactive: "The client communicates with the host over HTTP and WebSocket. The host runs the agent and routes every tool call to MCP connectors under a default-deny policy.",
  background: "The scheduler refreshes local mirrors, generates embeddings, distills durable knowledge into the wiki, and prepares Action Center items without blocking chat.",
  reliability: "Writes are journaled before execution, verified afterward against local mirrors, and retried safely when they cannot be confirmed.",
};
const planeDescription = document.querySelector("[data-plane-description]");
document.querySelectorAll("[data-plane]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-plane]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    if (planeDescription) planeDescription.textContent = planeDescriptions[button.dataset.plane];
  });
});

const lightbox = document.querySelector("[data-lightbox-dialog]");
const lightboxImage = lightbox?.querySelector("img");
document.querySelectorAll("[data-lightbox]").forEach((trigger) => {
  trigger.addEventListener("click", () => {
    if (!lightbox || !lightboxImage) return;
    lightboxImage.src = trigger.dataset.lightbox;
    lightbox.showModal();
  });
});
document.querySelector("[data-lightbox-close]")?.addEventListener("click", () => lightbox?.close());
lightbox?.addEventListener("click", (event) => {
  if (event.target === lightbox) lightbox.close();
});

document.querySelector("[data-copy-code]")?.addEventListener("click", async (event) => {
  const commands = ["npm install", "npm run dev -w @steward/llm-gateway", "npm run dev -w @steward/host", "npm run dev -w @steward/web"].join("\n");
  try {
    await navigator.clipboard.writeText(commands);
    event.currentTarget.textContent = "Copied ✓";
    window.setTimeout(() => (event.currentTarget.textContent = "Copy"), 1800);
  } catch {
    event.currentTarget.textContent = "Select";
  }
});
