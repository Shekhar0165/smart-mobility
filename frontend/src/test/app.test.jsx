import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App.jsx";
describe("dashboard routes", () => {
  it("protects dashboard and sends unauthenticated users to sign in", () => {
    localStorage.clear();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
  });
  it("shows login form fields", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
  it("opens Camera Cane by default after authentication", () => {
    localStorage.setItem("token", "test-token");
    localStorage.setItem(
      "user",
      JSON.stringify({ id: "caretaker-1", role: "caretaker" }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Camera Cane" }),
    ).toBeInTheDocument();
    expect(screen.getByText("CLEAR")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start camera + sound" }),
    ).toBeInTheDocument();
  });
});
