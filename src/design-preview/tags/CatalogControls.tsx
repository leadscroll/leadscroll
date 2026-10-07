import { tagColors } from './catalog';
import { type TagColor } from './model';
import { Menu } from '@base-ui/react/menu';
import { Check, Ellipsis } from 'lucide-react';

export const CatalogMenu = ({
  actions,
  label,
}: {
  readonly actions: Array<{
    danger?: boolean;
    label: string;
    onClick: () => void;
  }>;
  readonly label: string;
}) => (
  <Menu.Root>
    <Menu.Trigger
      aria-label={label}
      className="icon-button"
    >
      <Ellipsis size={16} />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner
        align="end"
        className="catalog-menu-positioner"
        sideOffset={5}
      >
        <Menu.Popup className="catalog-menu">
          {actions.map((action) => (
            <Menu.Item
              className="catalog-menu-item"
              data-danger={action.danger || undefined}
              key={action.label}
              onClick={() => action.onClick()}
            >
              {action.label}
            </Menu.Item>
          ))}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

export const CatalogColor = ({
  color,
  label,
  onChange,
}: {
  readonly color: TagColor;
  readonly label: string;
  readonly onChange: (color: TagColor) => void;
}) => (
  <Menu.Root>
    <Menu.Trigger
      aria-label={`Change color for ${label}`}
      className="catalog-color-control"
      title={`Color for ${label}`}
    >
      <span
        aria-hidden="true"
        className="catalog-color-swatch"
        data-color={color}
      />
      <span>{tagColors.find((item) => item.value === color)?.label}</span>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner
        align="end"
        className="catalog-menu-positioner"
        sideOffset={5}
      >
        <Menu.Popup className="catalog-menu">
          {tagColors.map((item) => (
            <Menu.Item
              className="catalog-menu-item"
              key={item.value}
              onClick={() => onChange(item.value)}
            >
              <span
                aria-hidden="true"
                className="catalog-color-swatch"
                data-color={item.value}
              />
              {item.label}
              {item.value === color && (
                <Check
                  aria-label="Selected"
                  className="catalog-color-check"
                  size={13}
                />
              )}
            </Menu.Item>
          ))}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);
