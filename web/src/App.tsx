import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { Footer, Nav } from "./components/chrome";
import Landing from "./pages/Landing";
import Playground from "./pages/Playground";
import Latest from "./pages/Latest";
import Exoskeleton from "./pages/Exoskeleton";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export default function App() {
  const { pathname } = useLocation();
  // The ops console renders its own full-bleed chrome.
  const bare = pathname === "/exoskeleton";

  useEffect(() => {
    document.documentElement.style.scrollBehavior = "smooth";
    return () => {
      document.documentElement.style.scrollBehavior = "";
    };
  }, []);
  return (
    <div className={bare ? "min-h-screen bg-[#0a0b12] text-slate-200 antialiased" : "min-h-screen bg-paper-100 text-paper-800 antialiased"}>
      <ScrollToTop />
      {!bare && <Nav />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/playground" element={<Playground />} />
        <Route path="/latest" element={<Latest />} />
        <Route path="/exoskeleton" element={<Exoskeleton />} />
        <Route path="*" element={<Landing />} />
      </Routes>
      {!bare && <Footer />}
    </div>
  );
}
