import ClientPage from "./client-page";

export default function DiscoverPage({ params }: { params: { cityId: string } }) {
  return <ClientPage cityId={params.cityId} />;
}
