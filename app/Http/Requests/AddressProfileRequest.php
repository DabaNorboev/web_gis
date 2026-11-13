<?php

namespace App\Http\Requests;

use App\Services\Addresses\AddressProfileService;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class AddressProfileRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'radius_m' => ['sometimes', 'integer', 'in:300,500'],
            'scope' => ['sometimes', 'in:selected'],
            'profile_version' => ['required_if:scope,selected', 'prohibited_unless:scope,selected', 'integer', 'in:1'],
            'blocks' => ['required_if:scope,selected', 'prohibited_unless:scope,selected', 'array', 'list', 'min:1', 'max:6'],
            'blocks.*' => ['string', 'distinct', Rule::in(AddressProfileService::BLOCKS)],
        ];
    }
}
