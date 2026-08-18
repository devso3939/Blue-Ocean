import ClientPage from "./client-page";

export default function AnalysisPage({ params }: { params: { id: string } }) {
  return <ClientPage id={params.id} />;
}
