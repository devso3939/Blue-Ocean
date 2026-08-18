import ClientPage from "./client-page";

export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function AnalysisPage({ params }: { params: { id: string } }) {
  return <ClientPage id={params.id} />;
}
