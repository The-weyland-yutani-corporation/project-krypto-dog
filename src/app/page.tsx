export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <h1 className="text-4xl font-bold">Project Krypto</h1>
      <p className="mt-4 text-lg text-gray-600">
        Autonomous AI Trading Agent — ETH/USDC
      </p>
      <a
        href="/admin"
        className="mt-8 rounded-lg bg-blue-600 px-6 py-3 text-white hover:bg-blue-700"
      >
        Admin Dashboard →
      </a>
    </main>
  );
}
