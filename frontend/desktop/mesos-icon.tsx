import { grindIcon } from './skill-icons';
export function MesosIcon({ size = 14, className = '', ...props }: { size?: number; className?: string; style?: React.CSSProperties; 'aria-label'?: string }) {
  return <img {...props} className={'mesos-icon ' + className} src={grindIcon('mesos.png')} alt={props['aria-label'] || ''} style={{ ...props.style, width: size, height: size, objectFit: 'contain' }} />;
}
