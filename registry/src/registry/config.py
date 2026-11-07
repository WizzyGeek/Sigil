from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql://sigil:sigil@localhost:5432/sigil"
    registry_private_key_pem: str = ""
    registry_public_key_pem: str = ""
    registry_domain: str = ""
    forwarded_allow_ips: str = "127.0.0.1,::1"

    email_smtp_host: str = ""
    email_smtp_port: int = 587
    email_smtp_user: str = ""
    email_smtp_pass: str = ""
    email_from_address: str = ""


settings = Settings()
