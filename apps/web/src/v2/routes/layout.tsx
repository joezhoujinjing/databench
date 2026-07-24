import { Outlet } from '@tanstack/react-router'
import { PostTrainingV2Gate } from '../components/PostTrainingV2Gate.js'

export function V2Layout() {
  return (
    <PostTrainingV2Gate>
      <Outlet />
    </PostTrainingV2Gate>
  )
}
