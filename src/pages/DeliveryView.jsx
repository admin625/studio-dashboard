import { useParams } from 'react-router-dom'
import Layout from '../components/Layout'

export default function DeliveryView() {
  const { id } = useParams()

  return (
    <Layout>
      <div className="text-center py-20">
        <p className="text-slate-500 text-sm mb-2">Delivery Detail — Phase 5</p>
        <p className="text-white font-mono text-xs">ID: {id}</p>
      </div>
    </Layout>
  )
}
